import { EventEmitter } from "events";
import { Module } from "./Module.js";
import { ModuleHealth } from "./ModuleHealth.js";
import { ModuleConfig, ModuleConfigData } from "./ModuleConfig.js";
import { createLogger } from "../utils/logger.js";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { dirname } from "dirname-filename-esm";
import { ModuleState, type ModuleConstructor } from "../types/index.js";
import { ModuleMemoryInspector } from "./ModuleMemoryInspector.js";
import { ModuleUpdater } from "./ModuleUpdater.js";

const __dirname = dirname(import.meta);

/**
 * @en Plugin interface for extending ModuleManager functionality
 * @ru Интерфейс плагина для расширения функциональности ModuleManager
 */
export interface PluginInterface {
	/**
	 * @en Plugin name
	 * @ru Имя плагина
	 */
	name: string;

	/**
	 * @en Initialize the plugin
	 * @ru Инициализировать плагин
	 * @param moduleManager - ModuleManager instance
	 */
	initialize(moduleManager: ModuleManager): Promise<void>;

	/**
	 * @en Plugin hooks for various lifecycle events
	 * @ru Хуки плагина для различных событий жизненного цикла
	 */
	hooks: {
		beforeModuleLoad?: (moduleName: string) => Promise<void>;
		afterModuleLoad?: (module: Module) => Promise<void>;
		beforeModuleInitialize?: (module: Module) => Promise<void>;
		afterModuleInitialize?: (module: Module) => Promise<void>;
		beforeModuleStart?: (module: Module) => Promise<void>;
		afterModuleStart?: (module: Module) => Promise<void>;
		beforeModuleStop?: (module: Module) => Promise<void>;
		afterModuleStop?: (module: Module) => Promise<void>;
		onError?: (
			error: Error,
			moduleName?: string,
			operation?: string,
		) => Promise<void>;
	};
}

/**
 * @en Metrics exporter interface for exporting module metrics
 * @ru Интерфейс экспортера метрик для экспорта метрик модулей
 */
export interface MetricsExporter {
	/**
	 * @en Export metrics to external system
	 * @ru Экспортировать метрики во внешнюю систему
	 * @param metrics - Metrics data to export
	 */
	exportMetrics(metrics: any): Promise<void>;
}

/**
 * @en Options for the ModuleManager constructor
 * @ru Опции для конструктора ModuleManager
 */
export interface ModuleManagerOptions {
	/**
	 * @en Path to modules directory
	 * @ru Путь к директории модулей
	 */
	modulesPath?: string;

	/**
	 * @en Path to configuration directory
	 * @ru Путь к директории конфигурации
	 */
	configPath?: string;

	/**
	 * @en Whether to automatically start modules after initialization
	 * @ru Автоматически запускать модули после инициализации
	 */
	autoStart?: boolean;

	/**
	 * @en Memory inspector options
	 * @ru Опции инспектора памяти
	 */
	memoryInspector?: {
		enabled?: boolean;
		snapshotInterval?: number;
		maxSnapshots?: number;
		thresholds?: {
			low: number;
			medium: number;
			high: number;
		};
	};

	/**
	 * @en Module recovery options
	 * @ru Опции восстановления модулей
	 */
	recovery?: {
		enabled?: boolean;
		maxAttempts?: number;
		delayMs?: number;
	};
}

/**
 * @en Manages the lifecycle of all modules in the application.
 * Handles loading, initialization, starting, and stopping modules.
 * @ru Управляет жизненным циклом всех модулей в приложении.
 * Обрабатывает загрузку, инициализацию, запуск и остановку модулей.
 */
export class ModuleManager extends EventEmitter {
	private modules: Map<string, Module> = new Map();
	private initialized = false;
	private modulesPath: string;
	private logger = createLogger("core");
	private startupTimestamp = 0;
	private moduleLoadPromises: Map<string, Promise<"loaded" | "disabled">> =
		new Map();
	private health: ModuleHealth;
	private config: ModuleConfig;
	private autoStart: boolean;
	private memoryInspector: ModuleMemoryInspector;
	private moduleUpdater: ModuleUpdater;
	private plugins: PluginInterface[] = [];
	private metricsExporters: MetricsExporter[] = [];
	private moduleCache = new Map<string, { timestamp: number; data: any }>();
	private recoveryAttempts = new Map<string, number>();
	private recoveryOptions: {
		enabled: boolean;
		maxAttempts: number;
		delayMs: number;
	};

	/**
	 * @en Creates a new ModuleManager instance
	 * @ru Создает новый экземпляр ModuleManager
	 * @param options - Configuration options
	 */
	constructor(options?: ModuleManagerOptions) {
		super();
		this.modulesPath =
			options?.modulesPath || path.resolve(__dirname, "../modules");
		this.health = new ModuleHealth();
		this.config = new ModuleConfig(options?.configPath);
		this.autoStart = options?.autoStart ?? true;

		// Set recovery options
		this.recoveryOptions = {
			enabled: options?.recovery?.enabled ?? false,
			maxAttempts: options?.recovery?.maxAttempts ?? 3,
			delayMs: options?.recovery?.delayMs ?? 5000,
		};

		// Create memory inspector with custom options
		this.memoryInspector = new ModuleMemoryInspector(this, {
			autoStart: false,
			snapshotInterval: options?.memoryInspector?.snapshotInterval,
			maxSnapshots: options?.memoryInspector?.maxSnapshots,
			thresholds: options?.memoryInspector?.thresholds,
		});

		// Subscribe to memory inspector events
		this.memoryInspector.on("memoryLeakDetected", (results) => {
			this.logger.warn(`Detected ${results.length} potential memory leaks`);
			this.emit("memoryLeaks", results);
		});

		this.moduleUpdater = new ModuleUpdater();

		// Set up error handling
		this.on("error", this.handleManagerError.bind(this));
		this.on("moduleError", (error, moduleName, operation) => {
			this.emit("error", error, moduleName, operation);

			// Attempt recovery if enabled
			if (
				this.recoveryOptions.enabled &&
				moduleName &&
				operation !== "initialization"
			) {
				this.attemptModuleRecovery(moduleName);
			}
		});

		// Set maximum number of listeners to avoid memory leaks
		this.setMaxListeners(100);
	}

	/**
	 * @en Register a plugin to extend ModuleManager functionality
	 * @ru Зарегистрировать плагин для расширения функциональности ModuleManager
	 * @param plugin - Plugin to register
	 */
	public async registerPlugin(plugin: PluginInterface): Promise<void> {
		try {
			this.plugins.push(plugin);
			await plugin.initialize(this);
			this.logger.info(`Plugin ${plugin.name} registered successfully`);
		} catch (error) {
			this.logger.error(`Failed to register plugin ${plugin.name}:`, error);
			throw error;
		}
	}

	/**
	 * @en Register a metrics exporter
	 * @ru Зарегистрировать экспортер метрик
	 * @param exporter - Metrics exporter to register
	 */
	public registerMetricsExporter(exporter: MetricsExporter): void {
		this.metricsExporters.push(exporter);
		this.logger.debug("Metrics exporter registered");
	}

	/**
	 * @en Export metrics to all registered exporters
	 * @ru Экспортировать метрики во все зарегистрированные экспортеры
	 */
	public async exportMetrics(): Promise<void> {
		const metrics = {
			modules: this.getModuleStatus(),
			health: this.health.getSystemHealth(),
			memory: await this.analyzeMemory(),
			timestamp: Date.now(),
		};

		await Promise.all(
			this.metricsExporters.map((exporter) => exporter.exportMetrics(metrics)),
		);

		this.logger.debug("Metrics exported successfully");
	}

	/**
	 * @en Get cached data with expiration
	 * @ru Получить кэшированные данные с истечением срока действия
	 * @param key - Cache key
	 * @param maxAge - Maximum age in milliseconds
	 * @returns Cached data or undefined if expired or not found
	 */
	public getCachedData<T>(key: string, maxAge: number = 60000): T | undefined {
		const cached = this.moduleCache.get(key);
		if (!cached) return undefined;

		if (Date.now() - cached.timestamp > maxAge) {
			this.moduleCache.delete(key);
			return undefined;
		}

		return cached.data as T;
	}

	/**
	 * @en Set cached data
	 * @ru Установить кэшированные данные
	 * @param key - Cache key
	 * @param data - Data to cache
	 */
	public setCachedData(key: string, data: any): void {
		this.moduleCache.set(key, { timestamp: Date.now(), data });
	}

	/**
	 * @en Broadcast an event to all modules
	 * @ru Транслировать событие всем модулям
	 * @param eventName - Name of the event
	 * @param data - Event data
	 * @param sourceModule - Optional source module name
	 */
	public async broadcastEvent(
		eventName: string,
		data: any,
		sourceModule?: string,
	): Promise<void> {
		for (const module of this.modules.values()) {
			if (module.name === sourceModule) continue;
			if (module.getState() !== ModuleState.RUNNING) continue;

			try {
				// Check if module has an event handler
				if (typeof (module as any).onEvent === "function") {
					await (module as any).onEvent(eventName, data, sourceModule);
				}
			} catch (error) {
				this.logger.error(
					`Error broadcasting event to module ${module.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * @en Check if a module's API version is compatible
	 * @ru Проверить, совместима ли версия API модуля
	 * @param moduleName - Name of the module
	 * @param requiredVersion - Required API version
	 * @returns True if compatible
	 */
	public isAPICompatible(moduleName: string, requiredVersion: string): boolean {
		const module = this.modules.get(moduleName);
		if (!module) return false;

		const currentVersion = module.getAPIVersion();
		return (
			this.moduleUpdater.compareVersions(currentVersion, requiredVersion) >= 0
		);
	}

	/**
	 * @en Attempt to recover a module after failure
	 * @ru Попытаться восстановить модуль после сбоя
	 * @param moduleName - Name of the module to recover
	 */
	private async attemptModuleRecovery(moduleName: string): Promise<void> {
		// Get current recovery attempts
		const attempts = this.recoveryAttempts.get(moduleName) || 0;

		// Check if max attempts reached
		if (attempts >= this.recoveryOptions.maxAttempts) {
			this.logger.warn(
				`Maximum recovery attempts (${this.recoveryOptions.maxAttempts}) reached for module ${moduleName}`,
			);
			return;
		}

		// Increment attempts
		this.recoveryAttempts.set(moduleName, attempts + 1);

		// Delay recovery attempt
		setTimeout(async () => {
			try {
				const module = this.getModule(moduleName);
				if (!module || !module.hasError()) return;

				this.logger.info(
					`Attempting to recover module ${moduleName} (attempt ${attempts + 1}/${this.recoveryOptions.maxAttempts})...`,
				);

				// Reset module state
				module.reset();

				// Try to reinitialize and start
				await module.initialize();
				await module.start();

				// Reset recovery attempts on success
				this.recoveryAttempts.delete(moduleName);

				this.logger.info(`Module ${moduleName} successfully recovered`);
			} catch (error) {
				this.logger.error(`Failed to recover module ${moduleName}:`, error);
			}
		}, this.recoveryOptions.delayMs);
	}

	/**
	 * @en Load all modules from the modules directory
	 * @ru Загружает все модули из директории модулей
	 */
	public async loadModules(): Promise<void> {
		this.startupTimestamp = performance.now();

		this.logger.info({
			message: "Starting module discovery...",
			moduleState: ModuleState.STARTING,
		});

		try {
			// Load module configurations first
			await this.config.loadAllConfigs();

			// Get all directories in the modules path
			const files = await fs.readdir(this.modulesPath);
			const moduleDirectories = await Promise.all(
				files.map(async (file) => {
					const fullPath = path.join(this.modulesPath, file);
					try {
						const stat = await fs.stat(fullPath);
						return stat.isDirectory() ? file : null;
					} catch (e) {
						this.logger.error({
							message: `Failed to load module from ${fullPath}: ${e}`,
							error: e,
							moduleState: ModuleState.ERROR,
						});
						return null;
					}
				}),
			);

			// Filter out null values
			const validDirectories = moduleDirectories.filter(
				(dir): dir is string => dir !== null,
			);

			let loadedCount = 0;
			let disabledCount = 0;
			let errorCount = 0;

			// Load modules in parallel for better performance
			await Promise.all(
				validDirectories.map(async (dir) => {
					try {
						// Check if we're already loading this module
						if (this.moduleLoadPromises.has(dir)) {
							await this.moduleLoadPromises.get(dir);
							return;
						}

						// Execute plugin hooks before module load
						for (const plugin of this.plugins) {
							if (plugin.hooks.beforeModuleLoad) {
								await plugin.hooks.beforeModuleLoad(dir);
							}
						}

						// Determine file extension based on environment
						const isDevMode = process.env.NODE_ENV === "development";
						const moduleFileName = `module.${isDevMode ? "ts" : "js"}`;
						const modulePath = String(
							pathToFileURL(path.join(this.modulesPath, dir, moduleFileName)),
						);

						// Create and store the loading promise
						const loadPromise = this.loadModuleFromPath(modulePath, dir);
						this.moduleLoadPromises.set(dir, loadPromise);

						// Wait for module to load
						const result = await loadPromise;

						if (result === "loaded") {
							loadedCount++;
						} else if (result === "disabled") {
							disabledCount++;
						}
					} catch (error) {
						errorCount++;
						this.logger.error({
							message: `Failed to load module from ${dir}: ${error}`,
							error,
							moduleState: ModuleState.ERROR,
						});
						throw error;
					}
				}),
			);

			const elapsedTime = (performance.now() - this.startupTimestamp).toFixed(
				2,
			);
			this.logger.info({
				message: `Module discovery completed in ${elapsedTime}ms: ${loadedCount} loaded, ${disabledCount} disabled, ${errorCount} failed`,
				moduleState: loadedCount > 0 ? ModuleState.STARTING : ModuleState.ERROR,
			});

			// Validate dependencies
			this.validateDependencies();
		} catch (error) {
			this.logger.error({
				message: "Failed to load modules:",
				error,
				moduleState: ModuleState.ERROR,
			});
			throw error;
		}
	}

	/**
	 * @en Load a module on demand by name
	 * @ru Загрузить модуль по требованию по имени
	 * @param moduleName - Name of the module to load
	 * @returns Module instance or undefined if not found or disabled
	 */
	public async loadModuleOnDemand(
		moduleName: string,
	): Promise<Module | undefined> {
		// Check if module is already loaded
		if (this.modules.has(moduleName)) {
			return this.modules.get(moduleName);
		}

		// Try to find and load the module
		try {
			// Execute plugin hooks before module load
			for (const plugin of this.plugins) {
				if (plugin.hooks.beforeModuleLoad) {
					await plugin.hooks.beforeModuleLoad(moduleName);
				}
			}

			const isDevMode = process.env.NODE_ENV === "development";
			const moduleFileName = `module.${isDevMode ? "ts" : "js"}`;
			const modulePath = String(
				pathToFileURL(path.join(this.modulesPath, moduleName, moduleFileName)),
			);

			const result = await this.loadModuleFromPath(modulePath, moduleName);
			if (result === "loaded") {
				const module = this.modules.get(moduleName);

				// Initialize and start if manager is already initialized
				if (module && this.initialized) {
					await module.initialize();
					if (this.autoStart) {
						await module.start();
					}
				}

				return module;
			}

			return undefined;
		} catch (error) {
			this.logger.error(
				`Failed to load module on demand: ${moduleName}`,
				error,
			);
			return undefined;
		}
	}

	/**
	 * @en Load a module from a specific path
	 * @ru Загружает модуль из указанного пути
	 * @param modulePath - Path to the module file
	 * @param dir - Directory name of the module
	 * @returns "loaded" if module was loaded, "disabled" if module was disabled
	 */
	private async loadModuleFromPath(
		modulePath: string,
		dir: string,
	): Promise<"loaded" | "disabled"> {
		try {
			const moduleImport = await import(modulePath);
			const ModuleClass = moduleImport.default;

			if (!ModuleClass || !(ModuleClass.prototype instanceof Module)) {
				this.logger.warn({
					message: `Invalid module in ${dir}: Module class must extend the base Module class`,
					moduleState: ModuleState.WARNING,
				});
				throw new Error(`Invalid module in ${dir}: Not a Module subclass`);
			}

			const module = new ModuleClass();

			// Important: set ModuleManager reference immediately after creating the module
			module.setModuleManager(this);

			// Check if module is disabled in config or metadata
			const moduleConfig = this.config.getConfig(module.name);
			const isDisabled = module.disabled || moduleConfig.disabled === true;

			if (isDisabled) {
				if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(`Module ${module.name} is disabled, skipping`);
				}
				return "disabled";
			}

			await this.registerModule(module);

			// Execute plugin hooks after module load
			for (const plugin of this.plugins) {
				if (plugin.hooks.afterModuleLoad) {
					await plugin.hooks.afterModuleLoad(module);
				}
			}

			return "loaded";
		} catch (error) {
			this.logger.error({
				message: `Error loading module from ${modulePath}:`,
				error,
				moduleState: ModuleState.ERROR,
			});
			throw error;
		}
	}

	/**
	 * @en Register a module with the manager
	 * @ru Регистрирует модуль в менеджере
	 * @param module - Module instance to register
	 */
	public async registerModule(module: Module): Promise<void> {
		if (this.modules.has(module.name)) {
			throw new Error(`Module ${module.name} is already registered`);
		}

		if (module.disabled) {
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(
					`Module ${module.name} is disabled, skipping registration`,
				);
			}
			return;
		}

		// Set up error handling for the module
		module.on("error", (error: Error, operation: string) => {
			this.health.trackError(module);
			this.emit("moduleError", error, module.name, operation);
		});

		// Set up state change handling
		module.on(
			"stateChange",
			(newState: ModuleState, previousState: ModuleState) => {
				if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(
						`Module ${module.name} state changed: ${previousState} -> ${newState}`,
					);
				}
			},
		);

		// Important: set ModuleManager reference again to ensure it's set
		module.setModuleManager(this);

		this.modules.set(module.name, module);

		// Only log in debug mode
		if (process.env.LOG_LEVEL === "debug") {
			this.logger.debug(`Registered module: ${module.name}`);
		}
	}

	/**
	 * @en Validate that all module dependencies can be satisfied
	 * @ru Проверяет, что все зависимости модулей могут быть удовлетворены
	 */
	private validateDependencies(): void {
		const moduleNames = new Set(this.modules.keys());
		let hasErrors = false;

		for (const [name, module] of this.modules.entries()) {
			for (const dependency of module.dependencies) {
				if (!moduleNames.has(dependency)) {
					this.logger.warn(
						`Module ${name} depends on ${dependency}, but it's not available`,
					);
					hasErrors = true;
				} else {
					// Check API version compatibility if specified
					const dependencyModule = this.modules.get(dependency);
					if (
						dependencyModule &&
						module.dependencyVersions &&
						module.dependencyVersions[dependency]
					) {
						const requiredVersion = module.dependencyVersions[dependency];
						const actualVersion = dependencyModule.getAPIVersion();

						if (
							this.moduleUpdater.compareVersions(
								actualVersion,
								requiredVersion,
							) < 0
						) {
							this.logger.warn(
								`Module ${name} requires ${dependency} version ${requiredVersion}, but found ${actualVersion}`,
							);
							hasErrors = true;
						}
					}
				}
			}
		}

		if (hasErrors) {
			this.logger.warn(
				"Some module dependencies could not be satisfied. This may cause issues during initialization.",
			);
		}
	}

	/**
	 * @en Initialize all modules in dependency order
	 * @ru Инициализирует все модули в порядке зависимостей
	 */
	public async initializeModules(): Promise<void> {
		if (this.initialized) {
			this.logger.warn({
				message: "ModuleManager is already initialized",
				moduleState: ModuleState.WARNING,
			});
			return;
		}

		this.logger.info({
			message: "Initializing modules...",
			moduleState: ModuleState.INITIALIZED,
		});

		const sortedModules = this.sortModulesByDependencies();
		const totalModules = sortedModules.length;
		let initializedCount = 0;
		let errorCount = 0;

		// Initialize modules sequentially in dependency order
		for (const module of sortedModules) {
			try {
				const currentState = module.getState();
				if (currentState === ModuleState.INITIALIZED) {
					initializedCount++;
					continue;
				}

				// Execute plugin hooks before module initialization
				for (const plugin of this.plugins) {
					if (plugin.hooks.beforeModuleInitialize) {
						await plugin.hooks.beforeModuleInitialize(module);
					}
				}

				// Track initialization performance
				this.health.trackStart(module, "initialize");
				await module.initialize();
				this.health.trackEnd(
					module,
					"initialize",
					module.getState() === ModuleState.INITIALIZED,
				);

				// Execute plugin hooks after module initialization
				for (const plugin of this.plugins) {
					if (plugin.hooks.afterModuleInitialize) {
						await plugin.hooks.afterModuleInitialize(module);
					}
				}

				initializedCount++;
			} catch (error) {
				errorCount++;
				this.logger.error({
					message: `Failed to initialize module: ${module.name}`,
					moduleState: ModuleState.ERROR,
					error,
				});
				this.emit("moduleError", error, module.name, "initialization");

				// Execute plugin hooks on error
				for (const plugin of this.plugins) {
					if (plugin.hooks.onError) {
						await plugin.hooks.onError(
							error instanceof Error ? error : new Error(String(error)),
							module.name,
							"initialization",
						);
					}
				}
			}
		}

		this.initialized = true;
		const elapsedTime = (performance.now() - this.startupTimestamp).toFixed(2);
		this.logger.info({
			message: `Module initialization completed in ${elapsedTime}ms: ${initializedCount}/${totalModules} initialized`,
			moduleState: ModuleState.INITIALIZED,
		});

		if (errorCount > 0) {
			this.logger.warn({
				message: `${errorCount} modules failed to initialize`,
				moduleState: ModuleState.WARNING,
			});
		}

		// Start memory inspector after initializing modules
		if (!this.memoryInspector.isRunning()) {
			this.memoryInspector.start();
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(
					"Module memory inspector started after initialization",
				);
			}
		}

		// Auto-start modules if configured
		if (this.autoStart) {
			await this.startModules();
		}
	}

	/**
	 * @en Start all modules in dependency order
	 * @ru Запускает все модули в порядке зависимостей
	 */
	public async startModules(): Promise<void> {
		if (!this.initialized) {
			throw new Error(
				"ModuleManager must be initialized before starting modules",
			);
		}

		const sortedModules = this.sortModulesByDependencies();
		const totalModules = sortedModules.length;
		let startedCount = 0;
		let errorCount = 0;

		this.logger.info({
			message: "Starting modules...",
			moduleState: ModuleState.STARTING,
		});

		for (const module of sortedModules) {
			try {
				const currentState = module.getState();
				if (currentState === ModuleState.RUNNING) {
					startedCount++;
					continue;
				}

				if (
					currentState !== ModuleState.INITIALIZED &&
					currentState !== ModuleState.STOPPED
				) {
					this.logger.warn({
						message: `Cannot start module ${module.name} from state ${currentState}`,
						moduleState: currentState,
					});
					continue;
				}

				// Execute plugin hooks before module start
				for (const plugin of this.plugins) {
					if (plugin.hooks.beforeModuleStart) {
						await plugin.hooks.beforeModuleStart(module);
					}
				}

				this.health.trackStart(module, "start");
				await module.start();
				this.health.trackEnd(
					module,
					"start",
					module.getState() === ModuleState.RUNNING,
				);

				// Execute plugin hooks after module start
				for (const plugin of this.plugins) {
					if (plugin.hooks.afterModuleStart) {
						await plugin.hooks.afterModuleStart(module);
					}
				}

				if (module.getState() !== ModuleState.RUNNING) {
					throw new Error(`Module ${module.name} failed to start properly`);
				}

				startedCount++;
			} catch (error) {
				errorCount++;
				this.logger.error({
					message: `Failed to start module: ${module.name}`,
					moduleState: ModuleState.ERROR,
					error,
				});
				this.emit("moduleError", error, module.name, "start");

				// Execute plugin hooks on error
				for (const plugin of this.plugins) {
					if (plugin.hooks.onError) {
						await plugin.hooks.onError(
							error instanceof Error ? error : new Error(String(error)),
							module.name,
							"start",
						);
					}
				}
			}
		}

		const elapsedTime = (performance.now() - this.startupTimestamp).toFixed(2);
		this.logger.info({
			message: `Module startup completed in ${elapsedTime}ms: ${startedCount}/${totalModules} started`,
			moduleState:
				startedCount === totalModules
					? ModuleState.STARTING
					: ModuleState.ERROR,
		});

		if (errorCount > 0) {
			this.logger.warn({
				message: `${errorCount} modules failed to start`,
				moduleState: ModuleState.ERROR,
			});
		}

		this.emit("ready", this.getModuleStatus());
	}

	/**
	 * @en Stop all modules in reverse dependency order
	 * @ru Останавливает все модули в обратном порядке зависимостей
	 */
	public async stopModules(): Promise<void> {
		// Stop memory inspector before stopping modules
		if (this.memoryInspector.isRunning()) {
			this.memoryInspector.stop();
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(
					"Module memory inspector stopped before module shutdown",
				);
			}
		}

		// Reverse the order to stop modules in the correct order
		const sortedModules = this.sortModulesByDependencies().reverse();
		const totalModules = sortedModules.length;
		let stoppedCount = 0;
		let errorCount = 0;

		this.logger.info({
			message: "Stopping modules...",
			moduleState: ModuleState.STOPPING,
		});

		for (const module of sortedModules) {
			try {
				const currentState = module.getState();
				if (currentState !== ModuleState.RUNNING) {
					this.logger.debug(
						`Module ${module.name} is not running (state: ${currentState}), skipping`,
					);
					continue;
				}

				// Execute plugin hooks before module stop
				for (const plugin of this.plugins) {
					if (plugin.hooks.beforeModuleStop) {
						await plugin.hooks.beforeModuleStop(module);
					}
				}

				// Track stop operation
				this.health.trackStart(module, "stop");
				await module.stop();
				this.health.trackEnd(
					module,
					"stop",
					module.getState() === ModuleState.STOPPED,
				);

				// Execute plugin hooks after module stop
				for (const plugin of this.plugins) {
					if (plugin.hooks.afterModuleStop) {
						await plugin.hooks.afterModuleStop(module);
					}
				}

				stoppedCount++;
				this.logger.debug(
					`Stopped module ${stoppedCount}/${totalModules}: ${module.name}`,
				);
			} catch (error) {
				errorCount++;
				this.logger.error({
					message: `Failed to stop module: ${module.name}`,
					moduleState: ModuleState.ERROR,
					error,
				});

				// Continue with other modules instead of throwing
				this.emit("moduleError", error, module.name, "stop");

				// Execute plugin hooks on error
				for (const plugin of this.plugins) {
					if (plugin.hooks.onError) {
						await plugin.hooks.onError(
							error instanceof Error ? error : new Error(String(error)),
							module.name,
							"stop",
						);
					}
				}
			}
		}

		this.initialized = false;
		this.logger.info({
			message: `Module shutdown completed: ${stoppedCount} stopped, ${errorCount} failed`,
			moduleState: ModuleState.STOPPED,
		});
	}

	/**
	 * @en Sort modules by dependencies using topological sort
	 * @ru Сортирует модули по зависимостям, используя топологическую сортировку
	 * @returns Array of modules sorted by dependencies
	 */
	private sortModulesByDependencies(): Module[] {
		const visited = new Set<string>();
		const sorted: Module[] = [];
		const visiting = new Set<string>();

		const visit = (moduleName: string) => {
			if (visited.has(moduleName)) return;
			if (visiting.has(moduleName)) {
				const cycle = Array.from(visiting).join(" -> ") + " -> " + moduleName;
				throw new Error(`Circular dependency detected: ${cycle}`);
			}

			visiting.add(moduleName);
			const module = this.modules.get(moduleName);
			if (!module) {
				throw new Error(`Module ${moduleName} not found`);
			}

			for (const depName of module.dependencies) {
				if (this.modules.has(depName)) {
					visit(depName);
				}
			}

			visiting.delete(moduleName);
			visited.add(moduleName);
			sorted.push(module);
		};

		// First sort modules by priority (higher priority first)
		const modulesByPriority = Array.from(this.modules.entries()).sort(
			([, a], [, b]) => (b.priority || 0) - (a.priority || 0),
		);

		for (const [moduleName] of modulesByPriority) {
			if (!visited.has(moduleName)) {
				visit(moduleName);
			}
		}

		return sorted;
	}

	/**
	 * @en Get a module by name with type safety
	 * @ru Получает модуль по имени с типовой безопасностью
	 * @param name - Name of the module
	 * @returns Module instance or undefined if not found
	 * @example getModule<typeof import("../modules/bot/module.js").default>("bot")
	 */
	public getModule<T extends Module>(name: string): T | undefined {
		return this.modules.get(name) as T | undefined;
	}

	/**
	 * @en Get the status of all modules
	 * @ru Получает статус всех модулей
	 * @returns Array of module status objects
	 */
	public getModuleStatus(): Array<{
		name: string;
		state: ModuleState;
		stateText: string;
		disabled: boolean;
		dependencies: string[];
		version: string;
		apiVersion: string;
		hasError: boolean;
		metrics?: {
			initTime?: number;
			startTime?: number;
			errorCount: number;
		};
	}> {
		return Array.from(this.modules.entries()).map(([name, module]) => {
			const metrics = this.health.getModuleMetrics(name);

			return {
				name,
				state: module.getState(),
				stateText: module.getState(),
				disabled: module.disabled,
				dependencies: module.dependencies,
				version: module.version,
				apiVersion: module.getAPIVersion(),
				hasError: module.hasError(),
				metrics: metrics
					? {
							initTime:
								metrics.operations.initialize.count > 0
									? metrics.operations.initialize.totalDuration /
										metrics.operations.initialize.count
									: undefined,
							startTime:
								metrics.operations.start.count > 0
									? metrics.operations.start.totalDuration /
										metrics.operations.start.count
									: undefined,
							errorCount: metrics.errorCount,
						}
					: undefined,
			};
		});
	}

	/**
	 * @en Get exports from a module with type safety
	 * @ru Получает экспорты из модуля с типовой безопасностью
	 * @template T - Type of module exports (defaults to Record<string, unknown>)
	 * @template K - Key of module exports
	 * @param moduleName - Name of the module
	 * @param exportKey - Optional specific export key to get
	 * @returns Module exports or specific export value
	 * @example
	 * // Get all exports
	 * const exports = manager.getModuleExports<BotModule["exports"]>("bot");
	 *
	 * // Get specific export
	 * const handler = manager.getModuleExports<BotModule["exports"], "messageHandler">("bot", "messageHandler");
	 */
	public getModuleExports<
		T = Record<string, unknown>,
		K extends keyof T = keyof T,
	>(moduleName: string, exportKey?: K): K extends undefined ? T : T[K] {
		const module = this.modules.get(moduleName);
		if (!module) {
			throw new Error(`Module ${moduleName} not found`);
		}

		if (exportKey !== undefined) {
			return module.exports[exportKey as string] as K extends undefined
				? T
				: T[K];
		}

		return module.exports as K extends undefined ? T : T[K];
	}

	/**
	 * @en Handle errors from the module manager
	 * @ru Обрабатывает ошибки из менеджера модулей
	 * @param error - Error object
	 * @param moduleName - Optional name of the module that caused the error
	 * @param operation - Optional operation during which the error occurred
	 */
	private handleManagerError(
		error: Error,
		moduleName?: string,
		operation?: string,
	): void {
		this.logger.error(
			`ModuleManager error${moduleName ? ` in module ${moduleName}` : ""}${operation ? ` during ${operation}` : ""}:`,
			error,
		);

		// Execute plugin hooks on error
		for (const plugin of this.plugins) {
			if (plugin.hooks.onError) {
				plugin.hooks
					.onError(error, moduleName, operation)
					.catch((pluginError) => {
						this.logger.error(
							`Error in plugin ${plugin.name} error handler:`,
							pluginError,
						);
					});
			}
		}
	}

	/**
	 * @en Restart a specific module
	 * @ru Перезапускает конкретный модуль
	 * @param moduleName - Name of the module to restart
	 */
	public async restartModule(moduleName: string): Promise<void> {
		const module = this.modules.get(moduleName);
		if (!module) {
			throw new Error(`Module ${moduleName} not found`);
		}

		this.logger.info(`Restarting module: ${moduleName}`);
		await module.restart();
		this.logger.info(`Module ${moduleName} restarted successfully`);
	}

	/**
	 * @en Create a new module instance and register it
	 * @ru Создает новый экземпляр модуля и регистрирует его
	 * @param ModuleClass - Module constructor
	 * @param options - Optional configuration for the module
	 * @returns New module instance
	 */
	public async createModule<T extends Module>(
		ModuleClass: ModuleConstructor<T>,
		options?: Record<string, unknown>,
	): Promise<T> {
		const module = new ModuleClass(options);
		await this.registerModule(module);

		if (this.initialized) {
			// If manager is already initialized, initialize and start the new module
			await module.initialize();
			await module.start();
		}

		return module;
	}

	/**
	 * @en Get all modules
	 * @ru Получает все модули
	 * @returns Array of all module instances
	 */
	public getAllModules(): Module[] {
		return Array.from(this.modules.values());
	}

	/**
	 * @en Get modules by state
	 * @ru Получает модули по состоянию
	 * @param state - Module state to filter by
	 * @returns Array of modules in the specified state
	 */
	public getModulesByState(state: ModuleState): Module[] {
		return this.getAllModules().filter((module) => module.getState() === state);
	}

	/**
	 * @en Check if all modules are in the running state
	 * @ru Проверяет, находятся ли все модули в состоянии выполнения
	 * @returns True if all modules are running or disabled
	 */
	public areAllModulesRunning(): boolean {
		return this.getAllModules().every(
			(module) => module.getState() === ModuleState.RUNNING || module.disabled,
		);
	}

	/**
	 * @en Get modules with errors
	 * @ru Получает модули с ошибками
	 * @returns Array of modules that have errors
	 */
	public getModulesWithErrors(): Module[] {
		return this.getAllModules().filter((module) => module.hasError());
	}

	/**
	 * @en Clear all modules
	 * @ru Очищает все модули
	 */
	public clearModules(): void {
		this.modules.clear();
		this.initialized = false;
		this.logger.info("All modules have been cleared");
	}

	/**
	 * @en Get module health metrics
	 * @ru Получает метрики здоровья модулей
	 * @returns Array of module metrics
	 */
	public getHealthMetrics() {
		return this.health.getMetrics();
	}

	/**
	 * @en Get the slowest modules
	 * @ru Получает самые медленные модули
	 * @returns Array of modules sorted by initialization time
	 */
	public getSlowestModules() {
		return this.health.getSlowestModules();
	}

	/**
	 * @en Get the most error-prone modules
	 * @ru Получает модули, наиболее подверженные ошибкам
	 * @returns Array of modules sorted by error count
	 */
	public getMostErrorProneModules() {
		return this.health.getMostErrorProneModules();
	}

	/**
	 * @en Get module configuration
	 * @ru Получает конфигурацию модуля
	 * @param moduleName - Name of the module
	 * @returns Module configuration
	 */
	public getModuleConfig<T extends ModuleConfigData = ModuleConfigData>(
		moduleName: string,
	): T {
		return this.config.getConfig<T>(moduleName);
	}

	/**
	 * @en Update module configuration
	 * @ru Обновляет конфигурацию модуля
	 * @param moduleName - Name of the module
	 * @param updates - Configuration updates to apply
	 * @returns Updated configuration
	 */
	public async updateModuleConfig(
		moduleName: string,
		updates: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.config.updateConfig(moduleName, updates);
	}

	/**
	 * @en Validate module configuration against a schema
	 * @ru Проверяет конфигурацию модуля по схеме
	 * @param moduleName - Name of the module
	 * @param schema - Configuration schema
	 * @returns True if configuration is valid
	 */
	public validateModuleConfig(
		moduleName: string,
		schema: Record<string, { type: string; required?: boolean }>,
	): boolean {
		const config = this.getModuleConfig(moduleName);

		for (const [key, def] of Object.entries(schema)) {
			if (def.required && config[key] === undefined) {
				return false;
			}

			if (config[key] !== undefined && typeof config[key] !== def.type) {
				return false;
			}
		}

		return true;
	}

	/**
	 * @en Get the path to a module's directory
	 * @ru Получает путь к директории модуля
	 * @param moduleName - Name of the module
	 * @returns Path to the module directory or undefined if not found
	 */
	public getModulePath(moduleName: string): string | undefined {
		return path.join(this.modulesPath, moduleName);
	}

	/**
	 * @en Get the memory inspector for modules
	 * @ru Получает инспектор памяти модулей
	 * @returns Memory inspector instance
	 */
	public getMemoryInspector(): ModuleMemoryInspector {
		return this.memoryInspector;
	}

	/**
	 * @en Analyze memory usage and return results
	 * @ru Анализирует использование памяти и возвращает результаты
	 * @returns Memory analysis results
	 */
	public async analyzeMemory(): Promise<{
		leaks: Array<{
			moduleName: string;
			severity: "low" | "medium" | "high";
			growthRate: number;
			recommendation: string;
		}>;
		report: {
			totalHeapUsed: number;
			totalHeapTotal: number;
			moduleStats: Array<{
				moduleName: string;
				heapGrowth: number;
				growthRate: number;
				leakProbability: "none" | "low" | "medium" | "high";
			}>;
		};
	}> {
		// Ensure inspector is running
		if (!this.memoryInspector.isRunning()) {
			this.memoryInspector.start();
		}

		// Take a snapshot
		this.memoryInspector.takeSnapshot();

		// Wait a bit for more accurate results
		await new Promise((resolve) => setTimeout(resolve, 5000));

		// Take another snapshot
		this.memoryInspector.takeSnapshot();

		// Analyze memory usage
		const leaks = this.memoryInspector.analyzeMemoryUsage();

		// Generate report
		const report = this.memoryInspector.generateMemoryReport();

		return {
			leaks: leaks.map((leak) => ({
				moduleName: leak.moduleName,
				severity: leak.severity,
				growthRate: leak.growthRate,
				recommendation: leak.recommendation,
			})),
			report: {
				totalHeapUsed: report.totalHeapUsed,
				totalHeapTotal: report.totalHeapTotal,
				moduleStats: report.moduleStats,
			},
		};
	}

	/**
	 * @en Clear all memory snapshots
	 * @ru Очищает все снимки памяти
	 */
	public clearMemorySnapshots(): void {
		this.memoryInspector.clearSnapshots();
	}

	/**
	 * @en Check for updates for all modules
	 * @ru Проверяет наличие обновлений для всех модулей
	 * @returns Array of update check results
	 */
	public async checkForModuleUpdates(): Promise<
		Array<{
			moduleName: string;
			currentVersion: string;
			latestVersion?: string;
			hasUpdate: boolean;
			repositoryUrl?: string;
		}>
	> {
		const results = [];

		for (const [moduleName] of this.modules.entries()) {
			// Get the path to the module directory
			const modulePath = this.getModulePath(moduleName);
			if (!modulePath) continue;

			// Check for updates
			const updateResult = await this.moduleUpdater.checkForUpdates(modulePath);
			if (updateResult) {
				results.push(updateResult);

				// Log update information
				if (updateResult.hasUpdate) {
					this.logger.info({
						message: `Update available for module ${moduleName}: ${updateResult.currentVersion} -> ${updateResult.latestVersion}`,
					});
				} else if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(`No updates available for module ${moduleName}`);
				}
			}
		}

		return results;
	}

	/**
	 * @en Attempt to recover a module
	 * @ru Попытка восстановить модуль
	 * @param moduleName - Name of the module to recover
	 * @returns True if recovery was successful
	 */
	public async recoverModule(moduleName: string): Promise<boolean> {
		const module = this.getModule(moduleName);
		if (!module || !module.hasError()) {
			return false;
		}

		try {
			this.logger.info(`Attempting to recover module ${moduleName}...`);

			// Reset module state
			module.reset();

			// Try to reinitialize and start
			await module.initialize();
			await module.start();

			// Reset recovery attempts on success
			this.recoveryAttempts.delete(moduleName);

			this.logger.info(`Module ${moduleName} successfully recovered`);
			return true;
		} catch (error) {
			this.logger.error(`Failed to recover module ${moduleName}:`, error);
			return false;
		}
	}
}
