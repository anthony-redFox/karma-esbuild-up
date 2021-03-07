import { debounce, formatTime } from "./utils";
import { Bundle } from "./bundle";
import chokidar, { FSWatcher } from "chokidar";
import * as karma from "karma";
import * as esbuild from "esbuild";
import * as path from "path";
import { SourceMapPayload } from "module";
import { IncomingMessage, ServerResponse } from "http";

interface KarmaFile {
	originalPath: string;
	path: string;
	contentPath: string;
	/** This is a must for mapped stack traces */
	sourceMap?: SourceMapPayload;
}

type KarmaPreprocess = (
	content: any,
	file: KarmaFile,
	done: (err: Error | null, content?: string | null) => void,
) => void;

interface KarmaLogger {
	create(
		label: string,
	): {
		info(message: string): void;
		error(message: string): void;
	};
}

const bundle = new Bundle();

function createPreprocessor(
	config: karma.ConfigOptions & {
		esbuild?: esbuild.BuildOptions & { bundleDelay?: number };
	},
	emitter: karma.Server,
	logger: KarmaLogger,
): KarmaPreprocess {
	const log = logger.create("esbuild");
	const base = config.basePath || process.cwd();

	// Inject middleware to handle the bundled file and map.
	if (!config.middleware) {
		config.middleware = [];
	}
	config.middleware.push("esbuild");

	// Create an empty file for Karma to track. Karma requires a real file in
	// order for it to be injected into the page, even though the middleware
	// will be responsible for serving it.
	if (!config.files) {
		config.files = [];
	}
	// Set preprocessor for our file to install sourceMap on it, giving Karma
	// the ability do unminify stack traces.
	config.preprocessors![bundle.file] = ["esbuild"];
	// For the sourcemapping to work, the file must be served by Karma, preprocessed, and have
	// the preproccessor attach a file.sourceMap.
	config.files.push({
		pattern: bundle.file,
		included: true,
		served: true,
		watched: false,
	});
	bundle.touch();

	let service: esbuild.Service | null = null;

	function processResult(
		result: esbuild.BuildResult & {
			outputFiles: esbuild.OutputFile[];
		},
		file: string,
	) {
		const map = result.outputFiles[0];
		const source = result.outputFiles[1];

		// Sources paths must be absolute, otherwise vscode will be unable
		// to find breakpoints
		const mapText = JSON.parse(map.text) as SourceMapPayload;
		mapText.sources = mapText.sources.map(s => path.join(base, s));

		const code =
			source.text + `\n//# sourceMappingURL=${path.basename(file)}.map`;

		return {
			code,
			parsedMap: mapText,
			map: JSON.stringify(mapText, null, 2),
		};
	}

	let watcher: FSWatcher | null = null;
	const watchMode = !config.singleRun && !!config.autoWatch;
	if (watchMode) {
		// Initialize watcher to listen for changes in basePath so
		// that we'll be notified of any new files
		const basePath = config.basePath || process.cwd();
		watcher = chokidar.watch([basePath], {
			ignoreInitial: true,
			// Ignore dot files and anything from node_modules
			ignored: /((^|[/\\])\..|node_modules)/,
		});
		// Register shutdown handler
		emitter.on("exit", done => {
			watcher!.close();
			done();
		});

		const onWatch = debounce(() => {
			emitter.refreshFiles();
		}, 100);
		watcher.on("change", onWatch);
		watcher.on("add", onWatch);
	}

	function makeUrl(path: string) {
		const url = `${config.protocol}//${config.hostname}:${config.port}`;
		return url + path;
	}

	async function build(contents: string, file: string) {
		const userConfig = { ...config.esbuild };

		const result = await service!.build({
			target: "es2015",
			...userConfig,
			bundle: true,
			write: false,
			stdin: {
				contents,
				resolveDir: path.dirname(file),
				sourcefile: path.basename(file),
			},
			platform: "browser",
			sourcemap: "external",
			outdir: base,
			define: {
				"process.env.NODE_ENV": JSON.stringify(
					process.env.NODE_ENV || "development",
				),
				...userConfig.define,
			},
		});

		return processResult(result, file);
	}

	const beforeProcess = debounce(() => {
		log.info("Compiling...");
	}, 10);
	const afterPreprocess = debounce((time: number) => {
		log.info(
			`Compiling done (${formatTime(Date.now() - time)}, with ${formatTime(
				bundleDelay,
			)} delay)`,
		);
	}, 10);

	let stopped = false;
	let count = 0;
	let startTime = 0;
	const bundleDelay = config.esbuild?.bundleDelay ?? 200;

	const writeBundle = debounce(async () => {
		if (service === null) {
			service = await esbuild.startService();
			emitter.on("exit", done => {
				stopped = true;
				service!.stop();
				done();
			});
		}

		try {
			const result = await build(bundle.generate(), bundle.file);
			bundle.write(result);

			count = 0;
			afterPreprocess(startTime);
		} catch (err) {
			log.error(err.message);

			bundle.write({
				code: (err.stack || "").replace(/^/g, "// "),
				parsedMap: {} as SourceMapPayload,
				map: "",
			});

			count = 0;
			afterPreprocess(startTime);
		}
	}, bundleDelay);

	return async function preprocess(content, file, done) {
		// Prevent service closed message when we are still processing
		if (stopped) return;

		// Karma likes to turn a win32 path (C:\foo\bar) into a posix-like path (C:/foo/bar).
		// Normally this wouldn't be so bad, but `bundle.file` is a true win32 path, and we
		// need to test equality.
		const filePath = path.normalize(file.originalPath);

		// If we're "preprocessing" the bundle file, all we need is to wait for
		// the sourcemap to be generated for it.
		if (filePath === bundle.file) {
			await writeBundle.current();
			const item = bundle.read();
			file.sourceMap = item.parsedMap;
			done(null, item.code);
			return;
		}

		if (count === 0) {
			beforeProcess();
			startTime = Date.now();
		}
		count++;

		bundle.addFile(filePath);
		await writeBundle();

		const dummy = [
			`/**`,
			` * ${filePath}`,
			` * See ${makeUrl(`/absolute${bundle.file}`)}`,
			` */`,
			`(function () {})()`,
		];
		done(null, dummy.join("\n"));
	};
}
createPreprocessor.$inject = ["config", "emitter", "logger"];

function createSourcemapMiddleware() {
	return async function (
		req: IncomingMessage,
		res: ServerResponse,
		next: () => void,
	) {
		const match = /^\/absolute([^?#]*)\.map(\?|#|$)/.exec(req.url || "");
		if (!match) return next();

		const filePath = path.normalize(match[1]);
		if (filePath !== bundle.file) return next();

		const item = bundle.read();
		res.setHeader("Content-Type", "application/json");
		res.end(item.map);
	};
}

module.exports = {
	"preprocessor:esbuild": ["factory", createPreprocessor],
	"middleware:esbuild": ["factory", createSourcemapMiddleware],
};
