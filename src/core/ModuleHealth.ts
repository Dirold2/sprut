import type { Module } from "./Module.js";
import type { ModuleState } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

/**
 * @en Metrics for a module operation
 * @ru Метрики для операции модуля
 */
export interface OperationMetrics {
	count: number;
	totalDuration: number;
	failures: number;
	lastDuration?: number;
	avgDuration?: number;
}

/**
 * @en Metrics for a module
 * @ru Метрики для модуля
 */
export interface ModuleMetrics {
	name: string;
	operations: {
		initialize: OperationMetrics;
		start: OperationMetrics;
		stop: OperationMetrics;
	};
	lastState: ModuleState;
	errorCount: number;
	lastErrorTime?: number;
}

/**
 * @en Tracks health metrics for modules
 * @ru Отслеживает метрики здоровья для модулей
 */
export class ModuleHealth {
	private startTimes = new Map<string, number>();
	private metrics = new Map<string, ModuleMetrics>();
	private logger = createLogger("ModuleHealth");

	constructor() {
		this.resetMetrics();
	}

	/**
	 * @en Reset all metrics
	 * @ru Сбрасывает все метрики
	 */
	public resetMetrics(): void {
		this.startTimes.clear();
		this.metrics.clear();
	}

	/**
	 * @en Track the start of a module operation
	 * @ru Отслеживает начало операции модуля
	 * @param module - Module instance
	 * @param operation - Type of operation
	 */
	public trackStart(
		module: Module,
		operation: "initialize" | "start" | "stop",
	): void {
		const key = `${module.name}:${operation}`;
		this.startTimes.set(key, performance.now());
	}

	/**
	 * @en Track the end of a module operation
	 * @ru Отслеживает завершение операции модуля
	 * @param module - Module instance
	 * @param operation - Type of operation
	 * @param success - Whether the operation was successful
	 */
	public trackEnd(
		module: Module,
		operation: "initialize" | "start" | "stop",
		success: boolean,
	): void {
		const key = `${module.name}:${operation}`;
		const startTime = this.startTimes.get(key);

		if (!startTime) {
			return;
		}

		const duration = performance.now() - startTime;
		this.startTimes.delete(key);

		// Get or create metrics for this module
		const moduleMetrics = this.getOrCreateMetrics(module);

		// Update metrics
		const opMetrics = moduleMetrics.operations[operation];
		opMetrics.count++;
		opMetrics.totalDuration += duration;
		opMetrics.lastDuration = duration;
		opMetrics.avgDuration = opMetrics.totalDuration / opMetrics.count;

		if (!success) {
			opMetrics.failures++;
			moduleMetrics.errorCount++;
			moduleMetrics.lastErrorTime = Date.now();
		}

		moduleMetrics.lastState = module.getState();

		// Log slow operations only if they're significantly slow (over 1 second)
		// and only in debug mode or if very slow (over 5 seconds)
		if (
			duration > 5000 ||
			(process.env.LOG_LEVEL === "debug" && duration > 1000)
		) {
			this.logger.warn(
				`Slow module operation: ${module.name}.${operation} took ${duration.toFixed(2)}ms`,
			);
		}
	}

	/**
	 * @en Track an error in a module
	 * @ru Отслеживает ошибку в модуле
	 * @param module - Module instance
	 */
	public trackError(module: Module): void {
		const moduleMetrics = this.getOrCreateMetrics(module);
		moduleMetrics.errorCount++;
		moduleMetrics.lastErrorTime = Date.now();
		moduleMetrics.lastState = module.getState();
	}

	/**
	 * @en Get or create default metrics for a module
	 * @ru Получает или создает метрики по умолчанию для модуля
	 * @param module - Module instance
	 * @returns Module metrics
	 */
	private getOrCreateMetrics(module: Module): ModuleMetrics {
		let metrics = this.metrics.get(module.name);

		if (!metrics) {
			metrics = {
				name: module.name,
				operations: {
					initialize: { count: 0, totalDuration: 0, failures: 0 },
					start: { count: 0, totalDuration: 0, failures: 0 },
					stop: { count: 0, totalDuration: 0, failures: 0 },
				},
				lastState: module.getState(),
				errorCount: 0,
			};
			this.metrics.set(module.name, metrics);
		}

		return metrics;
	}

	/**
	 * @en Get metrics for all modules
	 * @ru Получает метрики для всех модулей
	 * @returns Array of module metrics
	 */
	public getMetrics(): ModuleMetrics[] {
		return Array.from(this.metrics.values());
	}

	/**
	 * @en Get metrics for a specific module
	 * @ru Получает метрики для конкретного модуля
	 * @param moduleName - Name of the module
	 * @returns Module metrics or undefined if not found
	 */
	public getModuleMetrics(moduleName: string): ModuleMetrics | undefined {
		return this.metrics.get(moduleName);
	}

	/**
	 * @en Get modules sorted by initialization time
	 * @ru Получает модули, отсортированные по времени инициализации
	 * @returns Array of module metrics sorted by initialization time
	 */
	public getSlowestModules(): ModuleMetrics[] {
		return this.getMetrics()
			.filter((m) => m.operations.initialize.count > 0)
			.sort((a, b) => {
				const aAvg = a.operations.initialize.avgDuration || 0;
				const bAvg = b.operations.initialize.avgDuration || 0;
				return bAvg - aAvg;
			});
	}

	/**
	 * @en Get modules with the most errors
	 * @ru Получает модули с наибольшим количеством ошибок
	 * @returns Array of module metrics sorted by error count
	 */
	public getMostErrorProneModules(): ModuleMetrics[] {
		return this.getMetrics()
			.filter((m) => m.errorCount > 0)
			.sort((a, b) => b.errorCount - a.errorCount);
	}

	/**
	 * @en Get overall system health status
	 * @ru Получает общий статус здоровья системы
	 * @returns System health status object
	 */
	public getSystemHealth(): {
		healthy: boolean;
		errorCount: number;
		slowModules: number;
		metrics: {
			totalModules: number;
			totalErrors: number;
			avgInitTime: number;
			avgStartTime: number;
		};
	} {
		const metrics = this.getMetrics();
		const totalModules = metrics.length;
		const totalErrors = metrics.reduce((sum, m) => sum + m.errorCount, 0);

		let totalInitTime = 0;
		let initCount = 0;
		let totalStartTime = 0;
		let startCount = 0;

		metrics.forEach((m) => {
			if (m.operations.initialize.count > 0) {
				totalInitTime += m.operations.initialize.totalDuration;
				initCount += m.operations.initialize.count;
			}

			if (m.operations.start.count > 0) {
				totalStartTime += m.operations.start.totalDuration;
				startCount += m.operations.start.count;
			}
		});

		const avgInitTime = initCount > 0 ? totalInitTime / initCount : 0;
		const avgStartTime = startCount > 0 ? totalStartTime / startCount : 0;

		// Count modules that are significantly slower than average
		const slowThreshold = avgInitTime * 2;
		const slowModules = metrics.filter(
			(m) =>
				m.operations.initialize.avgDuration &&
				m.operations.initialize.avgDuration > slowThreshold,
		).length;

		return {
			healthy: totalErrors === 0,
			errorCount: totalErrors,
			slowModules,
			metrics: {
				totalModules,
				totalErrors,
				avgInitTime,
				avgStartTime,
			},
		};
	}
}
