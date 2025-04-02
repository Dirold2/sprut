import { ModuleManager } from "./core/ModuleManager.js";
import { createLogger } from "./utils/logger.js";
import path from "path";
import fs from "fs/promises";
import { dirname } from "dirname-filename-esm";
import { ModuleState } from "./types/index.js";
import { enableModuleLeakDetection } from "./utils/module-leak-detector.js";

const __dirname = dirname(import.meta);
const logger = createLogger("App");

/**
 * @en Application configuration interface
 * @ru Интерфейс конфигурации приложения
 */
interface AppConfig {
	modulesPath?: string;
	configPath?: string;
	autoStart?: boolean;
	autoRecovery?: boolean;
	memoryAnalysis?: {
		enabled: boolean;
		initialDelayMs: number;
		intervalMs: number;
	};
	leakDetection?: {
		enabled: boolean;
		checkOnShutdown: boolean;
	};
	updateCheck?: {
		enabled: boolean;
		delayMs: number;
	};
	shutdownTimeoutMs?: number;
	plugins?: Array<{
		path: string;
		options?: Record<string, unknown>;
	}>;
}

/**
 * @en Environment variables with defaults
 * @ru Переменные окружения со значениями по умолчанию
 */
const ENV = {
	NODE_ENV: process.env.NODE_ENV || "development",
	LOG_LEVEL: process.env.LOG_LEVEL || "info",
	CONFIG_PATH:
		process.env.CONFIG_PATH || path.resolve(__dirname, "./config/app.json"),
	ENABLE_LEAK_DETECTION: process.env.ENABLE_LEAK_DETECTION === "true",
	ENABLE_MEMORY_ANALYSIS: process.env.ENABLE_MEMORY_ANALYSIS === "true",
	ENABLE_PERIODIC_MEMORY_ANALYSIS:
		process.env.ENABLE_PERIODIC_MEMORY_ANALYSIS === "true",
	CHECK_LEAKS_ON_SHUTDOWN: process.env.CHECK_LEAKS_ON_SHUTDOWN === "true",
	MEMORY_ANALYSIS_INTERVAL: Number.parseInt(
		process.env.MEMORY_ANALYSIS_INTERVAL || "21600000",
		10,
	), // 6 часов
	MEMORY_ANALYSIS_INITIAL_DELAY: Number.parseInt(
		process.env.MEMORY_ANALYSIS_INITIAL_DELAY || "300000",
		10,
	), // 5 минут
	UPDATE_CHECK_DELAY: Number.parseInt(
		process.env.UPDATE_CHECK_DELAY || "10000",
		10,
	), // 10 секунд
	SHUTDOWN_TIMEOUT: Number.parseInt(
		process.env.SHUTDOWN_TIMEOUT || "30000",
		10,
	), // 30 секунд
	AUTO_RECOVERY: process.env.AUTO_RECOVERY === "true",
};

/**
 * @en Load application configuration from file
 * @ru Загрузка конфигурации приложения из файла
 * @returns Application configuration object
 */
async function loadConfig(): Promise<AppConfig> {
	try {
		const configData = await fs.readFile(ENV.CONFIG_PATH, "utf-8");
		const config = JSON.parse(configData);
		logger.info(`Configuration loaded from ${ENV.CONFIG_PATH}`);
		return config;
	} catch (error) {
		logger.warn(
			`Could not load config file, using defaults: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

/**
 * @en Get application version from package.json
 * @ru Получение версии приложения из package.json
 * @returns Application version
 */
async function getAppVersion(): Promise<string> {
	try {
		const packageJsonPath = path.resolve(__dirname, "../package.json");
		const packageData = await fs.readFile(packageJsonPath, "utf-8");
		const packageJson = JSON.parse(packageData);
		return packageJson.version || "unknown";
	} catch (error) {
		logger.warn(
			`Could not read package.json: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "unknown";
	}
}

/**
 * @en Attempt to recover a failed module
 * @ru Попытка восстановить модуль после сбоя
 * @param moduleManager - Module manager instance
 * @param moduleName - Name of the module to recover
 * @returns True if recovery was successful
 */
async function recoverModule(
	moduleManager: ModuleManager,
	moduleName: string,
): Promise<boolean> {
	try {
		const module = moduleManager.getModule(moduleName);
		if (!module || !module.hasError()) {
			return false;
		}

		logger.info(`Attempting to recover module ${moduleName}...`);

		// Reset module state
		module.reset();

		// Try to reinitialize and start
		await module.initialize();
		await module.start();

		logger.info(`Module ${moduleName} successfully recovered`);
		return true;
	} catch (error) {
		logger.error(
			`Failed to recover module ${moduleName}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * @en Main application entry point
 * @ru Основная точка входа в приложение
 * Initializes and manages the application lifecycle
 */
async function main() {
	let moduleManager: ModuleManager | null = null;
	let shuttingDown = false;
	let shutdownTimeout: NodeJS.Timeout | null = null;
	let memoryAnalysisInterval: NodeJS.Timeout | null = null;

	try {
		// Get application version
		const appVersion = await getAppVersion();

		// Log startup information with environment details
		logger.info({
			message: `Starting application v${appVersion}...`,
			environment: ENV.NODE_ENV,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			moduleState: ModuleState.STARTING,
		});

		// Load configuration
		const config = await loadConfig();

		// Enable memory leak detection if configured
		const enableLeakDetection =
			config.leakDetection?.enabled ?? ENV.ENABLE_LEAK_DETECTION;
		if (enableLeakDetection) {
			enableModuleLeakDetection();
			logger.info("Memory leak detection enabled for all modules");
		}

		// Create module manager with configuration
		moduleManager = new ModuleManager({
			modulesPath: config.modulesPath || path.resolve(__dirname, "./modules"),
			configPath: config.configPath || path.resolve(__dirname, "./config"),
			autoStart: config.autoStart !== undefined ? config.autoStart : true,
		});

		// Set up comprehensive error handling
		moduleManager.on("error", (error, moduleName, operation) => {
			logger.error(
				`Module error in ${moduleName || "unknown"} during ${operation || "unknown operation"}:`,
				error instanceof Error ? error : new Error(String(error)),
			);
		});

		// Set up module error handling with auto-recovery
		const autoRecovery = config.autoRecovery ?? ENV.AUTO_RECOVERY;
		moduleManager.on("moduleError", async (error, moduleName, operation) => {
			logger.error(`Module ${moduleName} failed during ${operation}:`, error);

			if (autoRecovery && operation !== "initialization" && !shuttingDown) {
				setTimeout(async () => {
					if (moduleManager && !shuttingDown) {
						const recovered = await recoverModule(moduleManager, moduleName);
						if (!recovered) {
							logger.warn(`Could not recover module ${moduleName}`);
						}
					}
				}, 5000); // Delay recovery attempt by 5 seconds
			}
		});

		// Subscribe to memory leak detection events
		moduleManager.on("memoryLeaks", (leaks) => {
			logger.warn({
				message: `Memory leak detection: Found ${leaks.length} potential memory leaks`,
				moduleState: ModuleState.WARNING,
			});

			leaks.forEach((leak: any) => {
				logger.warn({
					message: `Memory leak in module ${leak.moduleName}: ${leak.growthRate.toFixed(2)} MB/hour (${leak.severity} severity)`,
					recommendation: leak.recommendation,
					moduleState: ModuleState.WARNING,
				});
			});
		});

		// Set up ready event with detailed status reporting
		moduleManager.on("ready", (moduleStatus) => {
			const runningModules = moduleStatus.filter(
				(m: { state: ModuleState }) => m.state === ModuleState.RUNNING,
			).length;
			const totalModules = moduleStatus.length;

			logger.info({
				message: `Application ready! ${runningModules}/${totalModules} modules running`,
				moduleState: ModuleState.RUNNING,
			});

			// Log any modules with errors with structured data
			const modulesWithErrors = moduleStatus.filter(
				(m: { hasError: boolean }) => m.hasError,
			);
			if (modulesWithErrors.length > 0) {
				logger.error({
					message: `${modulesWithErrors.length} modules have errors:`,
					modules: modulesWithErrors.map((m: { name: unknown }) => m.name),
					moduleState: ModuleState.ERROR,
				});

				modulesWithErrors.forEach(
					(m: { name: unknown; state: unknown; hasError: Error }) => {
						logger.error({
							message: `- ${m.name} (${m.state})`,
							error:
								m.hasError instanceof Error
									? {
											message: m.hasError.message,
											stack: m.hasError.stack,
											name: m.hasError.name,
										}
									: String(m.hasError),
							moduleState: ModuleState.ERROR,
						});
					},
				);
			}

			// Schedule update check
			const updateCheckEnabled = config.updateCheck?.enabled !== false;
			const updateCheckDelay =
				config.updateCheck?.delayMs ?? ENV.UPDATE_CHECK_DELAY;

			if (updateCheckEnabled) {
				setTimeout(async () => {
					try {
						logger.info("Checking for module updates...");
						const updates = await moduleManager!.checkForModuleUpdates();

						const modulesWithUpdates = updates.filter(
							(update) => update.hasUpdate,
						);
						if (modulesWithUpdates.length > 0) {
							logger.info({
								message: `Updates available for ${modulesWithUpdates.length} modules:`,
							});

							modulesWithUpdates.forEach((update) => {
								logger.info({
									message: `- ${update.moduleName}: ${update.currentVersion} -> ${update.latestVersion}`,
								});
							});
						} else {
							logger.info("No updates available for any modules");
						}
					} catch (error) {
						logger.error("Error checking for module updates:", error);
					}
				}, updateCheckDelay);
			}

			// Set up periodic memory analysis
			const memoryAnalysisEnabled =
				config.memoryAnalysis?.enabled ??
				(ENV.ENABLE_MEMORY_ANALYSIS || ENV.ENABLE_PERIODIC_MEMORY_ANALYSIS);

			if (memoryAnalysisEnabled) {
				// Initial memory analysis
				const initialDelay =
					config.memoryAnalysis?.initialDelayMs ??
					ENV.MEMORY_ANALYSIS_INITIAL_DELAY;
				setTimeout(async () => {
					if (moduleManager && !shuttingDown) {
						await runMemoryAnalysis(moduleManager);
					}
				}, initialDelay);

				// Periodic memory analysis
				const analysisInterval =
					config.memoryAnalysis?.intervalMs ?? ENV.MEMORY_ANALYSIS_INTERVAL;
				memoryAnalysisInterval = setInterval(async () => {
					if (moduleManager && !shuttingDown) {
						await runMemoryAnalysis(moduleManager);
					}
				}, analysisInterval);

				// Make sure the interval doesn't prevent the process from exiting
				if (memoryAnalysisInterval.unref) {
					memoryAnalysisInterval.unref();
				}
			}
		});

		// Application lifecycle management
		await moduleManager.loadModules();
		await moduleManager.initializeModules();

		// Performance monitoring
		const slowestModules = moduleManager.getSlowestModules();
		if (slowestModules.length > 0) {
			logger.debug({
				message: "Slowest modules during initialization:",
				modules: slowestModules.map((m) => m.name),
				moduleState: ModuleState.DEBUG,
			});

			slowestModules.slice(0, 3).forEach((m) => {
				const avgTime =
					m.operations.initialize.totalDuration / m.operations.initialize.count;
				logger.debug({
					message: `- ${m.name}: ${avgTime.toFixed(2)}ms`,
					moduleState: ModuleState.DEBUG,
				});
			});
		}

		// Graceful shutdown handlers
		const shutdownHandler = async (signal: string) => {
			if (shuttingDown) {
				logger.warn(
					`Received another ${signal} signal during shutdown, forcing exit`,
				);
				process.exit(1);
			}

			shuttingDown = true;
			logger.info(`Received ${signal} signal, shutting down gracefully...`);

			// Clear any existing intervals
			if (memoryAnalysisInterval) {
				clearInterval(memoryAnalysisInterval);
				memoryAnalysisInterval = null;
			}

			// Set timeout for forced exit
			const shutdownTimeoutMs =
				config.shutdownTimeoutMs ?? ENV.SHUTDOWN_TIMEOUT;
			shutdownTimeout = setTimeout(() => {
				logger.error("Forced exit due to shutdown timeout");
				process.exit(1);
			}, shutdownTimeoutMs);

			try {
				if (!moduleManager) {
					logger.warn("ModuleManager not initialized, exiting immediately");
					process.exit(0);
					return;
				}

				// Check for memory leaks before shutdown if configured
				const checkLeaksOnShutdown =
					config.leakDetection?.checkOnShutdown ?? ENV.CHECK_LEAKS_ON_SHUTDOWN;
				if (checkLeaksOnShutdown && global.gc) {
					const { ModuleLeakDetector } = await import(
						"./utils/module-leak-detector.js"
					);
					logger.info("Checking for memory leaks before shutdown...");
					const leakedModules = await ModuleLeakDetector.checkForLeaks();

					if (leakedModules.length > 0) {
						logger.warn({
							message: `Detected ${leakedModules.length} modules with potential memory leaks: ${leakedModules.join(", ")}`,
							moduleState: ModuleState.WARNING,
						});
					}
				}

				await moduleManager.stopModules();

				if (shutdownTimeout) {
					clearTimeout(shutdownTimeout);
					shutdownTimeout = null;
				}

				logger.info("All modules stopped successfully");
				process.exit(0);
			} catch (error) {
				if (shutdownTimeout) {
					clearTimeout(shutdownTimeout);
					shutdownTimeout = null;
				}

				logger.error(
					`Error during shutdown: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
		};

		process.on("SIGINT", () => shutdownHandler("SIGINT"));
		process.on("SIGTERM", () => shutdownHandler("SIGTERM"));

		// Global error handlers
		process.on("uncaughtException", (error) => {
			logger.error("Uncaught exception:", error);
		});

		process.on("unhandledRejection", (reason) => {
			logger.error(
				"Unhandled rejection:",
				reason instanceof Error ? reason : new Error(String(reason)),
			);
		});
	} catch (error) {
		logger.error(
			"Fatal error during application startup:",
			error instanceof Error ? error : new Error(String(error)),
		);
		process.exit(1);
	}
}

/**
 * @en Run memory analysis and log results
 * @ru Запуск анализа памяти и логирование результатов
 * @param moduleManager - Module manager instance
 */
async function runMemoryAnalysis(moduleManager: ModuleManager): Promise<void> {
	try {
		logger.info("Running memory analysis...");
		const analysis = await moduleManager.analyzeMemory();

		if (analysis.leaks.length > 0) {
			logger.warn({
				message: `Memory analysis found ${analysis.leaks.length} potential memory leaks`,
				moduleState: ModuleState.WARNING,
			});
		} else {
			logger.info("Memory analysis completed. No memory leaks detected.");
		}

		// Log memory usage statistics
		logger.debug({
			message: "Memory usage statistics:",
			heapUsed: `${Math.round(analysis.report.totalHeapUsed)} MB`,
			heapTotal: `${Math.round(analysis.report.totalHeapTotal)} MB`,
			moduleCount: analysis.report.moduleStats.length,
			moduleState: ModuleState.DEBUG,
		});
	} catch (error) {
		logger.error(
			`Error during memory analysis: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// Start the application
main().catch((error) => {
	console.error("Unhandled error in main function:", error);
	process.exit(1);
});

// Add global gc declaration for TypeScript
declare global {
	namespace NodeJS {
		interface Global {
			gc?: () => void;
		}
	}
}
