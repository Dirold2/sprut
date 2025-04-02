import { EventEmitter } from "events";
import {
	type BaseModule,
	type ModuleMetadata,
	ModuleState,
} from "../types/index.js";
import { createLogger } from "../utils/index.js";
import type { ModuleManager } from "./ModuleManager.js";

/**
 * @en Abstract base class for all modules in the application.
 * Provides lifecycle management, dependency injection, and error handling.
 * @ru Абстрактный базовый класс для всех модулей в приложении.
 * Обеспечивает управление жизненным циклом, внедрение зависимостей и обработку ошибок.
 */
export abstract class Module extends EventEmitter implements BaseModule {
	protected _state: ModuleState = ModuleState.UNINITIALIZED;
	protected _error: Error | null = null;
	protected _logger: ReturnType<typeof createLogger>;
	private _moduleInitialized = false;
	private _startTime = 0;
	private _apiVersion: string | null = null;
	private _permissions = new Map<string, Set<string>>();

	/**
	 * @en Reference to the ModuleManager for inter-module communication
	 * @ru Ссылка на ModuleManager для межмодульного взаимодействия
	 */
	protected moduleManager?: ModuleManager;

	/**
	 * @en Module metadata must be defined by all concrete module implementations
	 * @ru Метаданные модуля должны быть определены всеми конкретными реализациями модуля
	 */
	public abstract readonly metadata: ModuleMetadata;

	/**
	 * @en Optional exports that this module provides to other modules
	 * @ru Опциональные экспорты, которые этот модуль предоставляет другим модулям
	 */
	public readonly exports: Record<string, unknown> = {};

	/**
	 * @en Optional version requirements for dependencies
	 * @ru Опциональные требования к версиям зависимостей
	 */
	public readonly dependencyVersions: Record<string, string> = {};

	constructor() {
		super();
		// Initialize logger with a temporary name
		const moduleName = this.getModuleName();
		this._logger = createLogger(moduleName);

		// Set up state change event listener
		this.on(
			"stateChange",
			(newState: ModuleState, previousState: ModuleState) => {
				if (process.env.LOG_LEVEL === "debug") {
					this._logger.debug(
						`Module state changed from ${previousState} to ${newState}`,
					);
				}
			},
		);

		// Set maximum number of listeners to avoid memory leaks
		this.setMaxListeners(50);
	}

	/**
	 * @en Set the ModuleManager reference for inter-module communication
	 * @ru Устанавливает ссылку на ModuleManager для межмодульного взаимодействия
	 * @param manager - ModuleManager instance
	 */
	public setModuleManager(manager: ModuleManager): void {
		this.moduleManager = manager;

		if (process.env.LOG_LEVEL === "debug") {
			this.logger.debug(
				`ModuleManager reference set for module ${this.name || "unknown"}`,
			);
		}
	}

	/**
	 * @en Get a module instance by name with type safety using typeof import
	 * @ru Получает экземпляр модуля по имени с типовой безопасностью, используя typeof import
	 * @param moduleName - Name of the module to get
	 * @returns Module instance or undefined if not found
	 * @example getModuleInstance<typeof import("../modules/bot/module.js").default>("bot")
	 */
	protected getModuleInstance<T extends Module>(
		moduleName: string,
	): T | undefined {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot get module ${moduleName}`,
			);
			return undefined;
		}
		return this.moduleManager.getModule<T>(moduleName);
	}

	/**
	 * @en Get exports from another module by name with type safety
	 * @ru Получает экспорты из другого модуля по имени с типовой безопасностью
	 * @template T - Type of module exports (defaults to Record<string, unknown>)
	 * @template K - Key of module exports
	 * @param moduleName - Name of the module to get exports from
	 * @param exportKey - Optional specific export key to get
	 * @returns Module exports or specific export value
	 */
	protected getExportsFromModule<
		T = Record<string, unknown>,
		K extends keyof T = keyof T,
	>(
		moduleName: string,
		exportKey?: K,
	): K extends undefined ? T : T[K] | undefined {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot get exports from module ${moduleName}`,
			);
			return undefined as K extends undefined ? T : T[K];
		}

		if (exportKey !== undefined) {
			return this.moduleManager.getModuleExports<T, K>(moduleName, exportKey);
		}

		return this.moduleManager.getModuleExports<T, K>(moduleName);
	}

	/**
	 * @en Broadcast an event to all other modules
	 * @ru Транслировать событие всем другим модулям
	 * @param eventName - Name of the event
	 * @param data - Event data
	 */
	protected async broadcastEvent(eventName: string, data: any): Promise<void> {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot broadcast event ${eventName}`,
			);
			return;
		}

		await this.moduleManager.broadcastEvent(eventName, data, this.name);
	}

	/**
	 * @en Handle an event from another module
	 * @ru Обработать событие от другого модуля
	 * @param eventName - Name of the event
	 * @param data - Event data
	 * @param sourceModule - Source module name
	 */
	public async onEvent?(
		eventName: string,
		data: any,
		sourceModule?: string,
	): Promise<void>;

	/**
	 * @en Check if a module's API version is compatible
	 * @ru Проверить, совместима ли версия API модуля
	 * @param moduleName - Name of the module
	 * @param requiredVersion - Required API version
	 * @returns True if compatible
	 */
	protected isModuleAPICompatible(
		moduleName: string,
		requiredVersion: string,
	): boolean {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot check API compatibility for ${moduleName}`,
			);
			return false;
		}

		return this.moduleManager.isAPICompatible(moduleName, requiredVersion);
	}

	/**
	 * @en Get the API version of this module
	 * @ru Получить версию API этого модуля
	 * @returns API version
	 */
	public getAPIVersion(): string {
		if (this._apiVersion) {
			return this._apiVersion;
		}

		return this.metadata.version || this.version;
	}

	/**
	 * @en Set the API version of this module
	 * @ru Установить версию API этого модуля
	 * @param version - API version
	 */
	protected setAPIVersion(version: string): void {
		this._apiVersion = version;
	}

	/**
	 * @en Check permission for an action on a resource
	 * @ru Проверить разрешение на действие с ресурсом
	 * @param action - Action to check
	 * @param resource - Resource to check
	 * @returns True if permitted
	 */
	protected async checkPermission(
		action: string,
		resource: string,
	): Promise<boolean> {
		// Check local permissions first
		const resourcePermissions = this._permissions.get(resource);
		if (resourcePermissions && resourcePermissions.has(action)) {
			return true;
		}

		// If no local permission, check with auth module if available
		if (this.moduleManager) {
			const authModule = this.moduleManager.getModule("auth");
			if (
				authModule &&
				typeof (authModule as any).checkModulePermission === "function"
			) {
				return await (authModule as any).checkModulePermission(
					this.name,
					action,
					resource,
				);
			}
		}

		// Default to true if no auth module is available
		return true;
	}

	/**
	 * @en Grant permission for an action on a resource
	 * @ru Предоставить разрешение на действие с ресурсом
	 * @param action - Action to grant
	 * @param resource - Resource to grant access to
	 */
	protected grantPermission(action: string, resource: string): void {
		let resourcePermissions = this._permissions.get(resource);
		if (!resourcePermissions) {
			resourcePermissions = new Set<string>();
			this._permissions.set(resource, resourcePermissions);
		}

		resourcePermissions.add(action);
	}

	/**
	 * @en Revoke permission for an action on a resource
	 * @ru Отозвать разрешение на действие с ресурсом
	 * @param action - Action to revoke
	 * @param resource - Resource to revoke access from
	 */
	protected revokePermission(action: string, resource: string): void {
		const resourcePermissions = this._permissions.get(resource);
		if (resourcePermissions) {
			resourcePermissions.delete(action);
			if (resourcePermissions.size === 0) {
				this._permissions.delete(resource);
			}
		}
	}

	/**
	 * @en Extracts the module name from the stack trace
	 * This is a fallback method used before metadata is available
	 * @ru Извлекает имя модуля из стека вызовов
	 * Это резервный метод, используемый до того, как метаданные станут доступны
	 * @returns Module name
	 */
	private getModuleName(): string {
		try {
			// Get stack trace to determine calling file
			const stack = new Error().stack || "";
			const stackLines = stack.split("\n");

			// Look for a path containing /modules/ in the stack
			for (const line of stackLines) {
				const match = line.match(/\/modules\/([^/]+)/);
				if (match && match[1]) {
					return match[1];
				}
			}

			return "unknown-module";
		} catch (error) {
			console.error("Error extracting module name from file path:", error);
			return "unknown-module";
		}
	}

	/**
	 * @en Logger instance for this module
	 * @ru Экземпляр логгера для этого модуля
	 */
	public get logger() {
		if (!this._moduleInitialized && this.metadata?.name) {
			this._logger = createLogger(this.metadata.name);
			this._moduleInitialized = true;
		}
		return this._logger;
	}

	// Metadata accessors with defaults for safety
	/**
	 * @en Get module name
	 * @ru Получить имя модуля
	 */
	public get name(): string {
		return this.metadata.name || "unnamed-module";
	}

	/**
	 * @en Get module description
	 * @ru Получить описание модуля
	 */
	public get description(): string {
		return this.metadata.description || "";
	}

	/**
	 * @en Get module version
	 * @ru Получить версию модуля
	 */
	public get version(): string {
		return this.metadata.version || "0.0.0";
	}

	/**
	 * @en Get module dependencies
	 * @ru Получить зависимости модуля
	 */
	public get dependencies(): string[] {
		return this.metadata.dependencies || [];
	}

	/**
	 * @en Check if module is disabled
	 * @ru Проверить, отключен ли модуль
	 */
	public get disabled(): boolean {
		return this.metadata.disabled || false;
	}

	/**
	 * @en Get module priority
	 * @ru Получить приоритет модуля
	 */
	public get priority(): number {
		return this.metadata.priority ?? 50; // Default priority is 50
	}

	/**
	 * @en Get module state
	 * @ru Получить состояние модуля
	 */
	public get state(): ModuleState {
		return this._state;
	}

	/**
	 * @en Initialize the module
	 * This is called by the ModuleManager during system startup
	 * @ru Инициализировать модуль
	 * Вызывается ModuleManager во время запуска системы
	 */
	public async initialize(): Promise<void> {
		if (this._state !== ModuleState.UNINITIALIZED) {
			this.logger.warn(
				`Module ${this.name} is already initialized or in progress (state: ${this._state})`,
			);
			return;
		}

		this._startTime = performance.now();

		try {
			this.setState(ModuleState.INITIALIZING);

			// Only log initialization start in debug mode
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(`Initializing module ${this.name}...`);
			}

			// Call the module-specific initialization logic
			await this.onInitialize();

			this.setState(ModuleState.INITIALIZED);

			const initTime = performance.now() - this._startTime;
			this.logger.info({
				message: `Module ${this.name} initialized in ${initTime.toFixed(2)}ms`,
				moduleState: ModuleState.INITIALIZED,
			});
		} catch (error) {
			this.handleError("initialization", error);
			throw error;
		}
	}

	/**
   * @en Start the module
   * This is called by  error)
      throw error
    }
  }

  /**
   * @en Start the module
   * This is called by the ModuleManager after all modules are initialized
   * @ru Запустить модуль
   * Вызывается ModuleManager после инициализации всех модулей
   */
	public async start(): Promise<void> {
		if (
			this._state !== ModuleState.INITIALIZED &&
			this._state !== ModuleState.STOPPED
		) {
			this.logger.warn(
				`Cannot start module ${this.name} from state ${this._state}`,
			);
			return;
		}

		this._startTime = performance.now();

		try {
			this.setState(ModuleState.STARTING);

			// Only log start in debug mode
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(`Starting module ${this.name}...`);
			}

			// Call the module-specific start logic
			await this.onStart();

			this.setState(ModuleState.RUNNING);

			const startTime = performance.now() - this._startTime;
			this.logger.info({
				message: `Module ${this.name} started in ${startTime.toFixed(2)}ms`,
				moduleState: ModuleState.STARTING,
			});
		} catch (error) {
			this.handleError("start", error);
			throw error;
		}
	}

	/**
	 * @en Stop the module
	 * This is called by the ModuleManager during system shutdown
	 * @ru Остановить модуль
	 * Вызывается ModuleManager во время завершения работы системы
	 */
	public async stop(): Promise<void> {
		if (this._state !== ModuleState.RUNNING) {
			this.logger.warn(
				`Cannot stop module ${this.name} from state ${this._state}`,
			);
			return;
		}

		this._startTime = performance.now();

		try {
			this.setState(ModuleState.STOPPING);

			// Only log stop in debug mode
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(`Stopping module ${this.name}...`);
			}

			// Call the module-specific stop logic
			await this.onStop();

			this.setState(ModuleState.STOPPED);

			const stopTime = performance.now() - this._startTime;
			this.logger.info(
				`Module ${this.name} stopped in ${stopTime.toFixed(2)}ms`,
			);
		} catch (error) {
			this.handleError("stop", error);
			throw error;
		}
	}

	/**
	 * @en Restart the module
	 * @ru Перезапустить модуль
	 */
	public async restart(): Promise<void> {
		this.logger.info(`Restarting module ${this.name}...`);
		await this.stop();
		await this.start();
		this.logger.info(`Module ${this.name} restarted successfully`);
	}

	/**
	 * @en Get the current state of the module
	 * @ru Получить текущее состояние модуля
	 * @returns Current module state
	 */
	public getState(): ModuleState {
		return this._state;
	}

	/**
	 * @en Get the last error that occurred in the module, if any
	 * @ru Получить последнюю ошибку, произошедшую в модуле, если таковая имеется
	 * @returns Last error or null if no error
	 */
	public getError(): Error | null {
		return this._error;
	}

	/**
	 * @en Update the module state and emit a state change event
	 * @ru Обновить состояние модуля и вызвать событие изменения состояния
	 * @param state - New state
	 */
	protected setState(state: ModuleState): void {
		const previousState = this._state;
		this._state = state;

		// Only emit if the state actually changed
		if (previousState !== state) {
			this.emit("stateChange", state, previousState);
		}
	}

	/**
	 * @en Handle an error that occurred during module lifecycle
	 * @ru Обработать ошибку, произошедшую во время жизненного цикла модуля
	 * @param operation - Operation during which the error occurred
	 * @param error - Error object
	 */
	protected handleError(operation: string, error: unknown): void {
		this._error = error instanceof Error ? error : new Error(String(error));
		this.setState(ModuleState.ERROR);

		// Log detailed error information
		this.logger.error({
			message: `Error during module ${operation} in ${this.name}:`,
			operation,
			error: this._error,
			stack: this._error.stack,
			moduleState: ModuleState.ERROR,
		});

		// Emit an error event that can be handled by the ModuleManager
		this.emit("error", this._error, operation);
	}

	/**
	 * @en Reset the module to its initial state
	 * This can be used to recover from errors
	 * @ru Сбросить модуль в исходное состояние
	 * Это может быть использовано для восстановления после ошибок
	 */
	public reset(): void {
		this._error = null;
		this.setState(ModuleState.UNINITIALIZED);
		this.logger.info(`Module ${this.name} has been reset`);
	}

	/**
	 * @en Check if the module is in a specific state
	 * @ru Проверить, находится ли модуль в определенном состоянии
	 * @param state - State to check
	 * @returns True if the module is in the specified state
	 */
	public isInState(state: ModuleState): boolean {
		return this._state === state;
	}

	/**
	 * @en Check if the module is ready to be used
	 * @ru Проверить, готов ли модуль к использованию
	 * @returns True if the module is ready
	 */
	public isReady(): boolean {
		return this._state === ModuleState.RUNNING;
	}

	/**
	 * @en Check if the module has an error
	 * @ru Проверить, есть ли у модуля ошибка
	 * @returns True if the module has an error
	 */
	public hasError(): boolean {
		return this._state === ModuleState.ERROR || this._error !== null;
	}

	/**
	 * @en Get uptime of the module in milliseconds
	 * @ru Получить время работы модуля в миллисекундах
	 * @returns Uptime in milliseconds
	 */
	public getUptime(): number {
		if (this._state !== ModuleState.RUNNING) {
			return 0;
		}
		return this._startTime > 0 ? performance.now() - this._startTime : 0;
	}

	/**
	 * @en Get module configuration with type safety
	 * @ru Получить конфигурацию модуля с типовой безопасностью
	 * @returns Module configuration
	 */
	protected getConfig<
		T extends Record<string, unknown> = Record<string, unknown>,
	>(): T {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot get config`,
			);
			return {} as T;
		}

		return this.moduleManager.getModuleConfig<T>(this.name);
	}

	/**
	 * @en Update module configuration
	 * @ru Обновить конфигурацию модуля
	 * @param updates - Configuration updates to apply
	 * @returns Updated configuration
	 */
	protected async updateConfig(
		updates: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot update config`,
			);
			return updates;
		}

		return this.moduleManager.updateModuleConfig(this.name, updates);
	}

	/**
	 * @en Validate module configuration against a schema
	 * @ru Проверить конфигурацию модуля по схеме
	 * @param schema - Configuration schema
	 * @returns True if configuration is valid
	 */
	protected validateConfig(
		schema: Record<string, { type: string; required?: boolean }>,
	): boolean {
		if (!this.moduleManager) {
			this.logger.warn(
				`ModuleManager not available in ${this.name}, cannot validate config`,
			);
			return false;
		}

		return this.moduleManager.validateModuleConfig(this.name, schema);
	}

	// Abstract methods to be implemented by concrete modules
	/**
	 * @en Module-specific initialization logic
	 * @ru Логика инициализации, специфичная для модуля
	 */
	protected async onInitialize(): Promise<void> {}

	/**
	 * @en Module-specific start logic
	 * @ru Логика запуска, специфичная для модуля
	 */
	protected async onStart(): Promise<void> {}

	/**
	 * @en Module-specific stop logic
	 * @ru Логика остановки, специфичная для модуля
	 */
	protected async onStop(): Promise<void> {}
}
