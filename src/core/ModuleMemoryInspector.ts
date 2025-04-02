import { EventEmitter } from "events";
import type { Module } from "./Module.js";
import { createLogger } from "../utils/logger.js";
import type { ModuleManager } from "./ModuleManager.js";

/**
 * @en Memory snapshot for a module
 * @ru Снимок памяти для модуля
 */
interface ModuleMemorySnapshot {
	timestamp: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
	references: number; // Count of references to the module
}

/**
 * @en Memory leak detection result
 * @ru Результат обнаружения утечки памяти
 */
interface MemoryLeakResult {
	moduleName: string;
	severity: "low" | "medium" | "high";
	growthRate: number; // MB per hour
	snapshots: ModuleMemorySnapshot[];
	recommendation: string;
}

/**
 * @en Options for the ModuleMemoryInspector
 * @ru Опции для ModuleMemoryInspector
 */
interface MemoryInspectorOptions {
	/**
	 * @en Interval in milliseconds between memory snapshots
	 * @ru Интервал в миллисекундах между снимками памяти
	 * @default 300000 (5 minutes)
	 */
	snapshotInterval?: number;

	/**
	 * @en Number of snapshots to keep per module
	 * @ru Количество снимков для хранения на модуль
	 * @default 12
	 */
	maxSnapshots?: number;

	/**
	 * @en Threshold for memory growth rate (MB per hour) to consider as a leak
	 * @ru Порог скорости роста памяти (МБ в час) для рассмотрения как утечки
	 * @default { low: 5, medium: 20, high: 50 }
	 */
	thresholds?: {
		low: number;
		medium: number;
		high: number;
	};

	/**
	 * @en Whether to automatically start the inspector
	 * @ru Автоматически запускать инспектор
	 * @default true
	 */
	autoStart?: boolean;
}

/**
 * @en Inspects module memory usage to detect potential memory leaks
 * @ru Проверяет использование памяти модулем для обнаружения потенциальных утечек памяти
 */
export class ModuleMemoryInspector extends EventEmitter {
	private moduleManager: ModuleManager;
	private snapshots = new Map<string, ModuleMemorySnapshot[]>();
	private intervalId: ReturnType<typeof setTimeout> | null = null;
	private logger = createLogger("cmi");
	private options: Required<MemoryInspectorOptions>;
	private weakRefs = new Map<string, WeakRef<Module>>();
	private registry: FinalizationRegistry<string>;

	/**
	 * @en Creates a new ModuleMemoryInspector
	 * @ru Создает новый ModuleMemoryInspector
	 * @param moduleManager - ModuleManager instance
	 * @param options - Configuration options
	 */
	constructor(moduleManager: ModuleManager, options?: MemoryInspectorOptions) {
		super();
		this.moduleManager = moduleManager;

		// Set default options
		this.options = {
			snapshotInterval: options?.snapshotInterval ?? 300000, // 5 minutes
			maxSnapshots: options?.maxSnapshots ?? 12, // Keep 12 snapshots (1 hour with default interval)
			thresholds: options?.thresholds ?? {
				low: 5, // 5 MB/hour
				medium: 20, // 20 MB/hour
				high: 50, // 50 MB/hour
			},
			autoStart: options?.autoStart ?? true,
		};

		// Create finalization registry to track when modules are garbage collected
		this.registry = new FinalizationRegistry((moduleName: string) => {
			if (process.env.LOG_LEVEL === "debug") {
				this.logger.debug(`Module ${moduleName} was garbage collected`);
			}
			this.weakRefs.delete(moduleName);
		});

		// Auto-start if configured
		if (this.options.autoStart) {
			this.start();
		}
	}

	/**
	 * @en Start the memory inspector
	 * @ru Запустить инспектор памяти
	 */
	public start(): void {
		if (this.intervalId) {
			this.logger.warn("Memory inspector is already running");
			return;
		}

		this.logger.info("Starting module memory inspector");

		// Take initial snapshot
		this.takeSnapshot();

		// Schedule regular snapshots
		this.intervalId = setInterval(() => {
			this.takeSnapshot();
			this.analyzeMemoryUsage();
		}, this.options.snapshotInterval);

		// Make sure the interval doesn't prevent the process from exiting
		if (this.intervalId.unref) {
			this.intervalId.unref();
		}
	}

	/**
	 * @en Stop the memory inspector
	 * @ru Остановить инспектор памяти
	 */
	public stop(): void {
		if (!this.intervalId) {
			this.logger.warn("Memory inspector is not running");
			return;
		}

		clearInterval(this.intervalId);
		this.intervalId = null;
		this.logger.info("Stopped module memory inspector");
	}

	/**
	 * @en Take a memory snapshot of all modules
	 * @ru Сделать снимок памяти всех модулей
	 */
	public takeSnapshot(): void {
		if (process.env.LOG_LEVEL === "debug") {
			this.logger.debug("Taking memory snapshot of all modules");
		}

		// Force garbage collection if available (Node with --expose-gc flag)
		if (global.gc) {
			global.gc();
		}

		// Get memory usage
		const memoryUsage = process.memoryUsage();

		// Get all modules
		const modules = this.moduleManager.getAllModules();

		// Update weak references to modules
		modules.forEach((module: Module) => {
			if (!this.weakRefs.has(module.name)) {
				const weakRef = new WeakRef(module);
				this.weakRefs.set(module.name, weakRef);
				this.registry.register(module, module.name);
			}
		});

		// Take snapshot for each module
		modules.forEach((module: Module) => {
			// Skip disabled modules
			if (module.disabled) return;

			// Create snapshot
			const snapshot: ModuleMemorySnapshot = {
				timestamp: Date.now(),
				heapUsed: memoryUsage.heapUsed,
				heapTotal: memoryUsage.heapTotal,
				external: memoryUsage.external,
				arrayBuffers: memoryUsage.arrayBuffers || 0,
				references: this.countReferences(module),
			};

			// Get existing snapshots or create new array
			const moduleSnapshots = this.snapshots.get(module.name) || [];

			// Add new snapshot
			moduleSnapshots.push(snapshot);

			// Limit number of snapshots
			if (moduleSnapshots.length > this.options.maxSnapshots) {
				moduleSnapshots.shift();
			}

			// Update snapshots
			this.snapshots.set(module.name, moduleSnapshots);
		});
	}

	/**
	 * @en Check if the memory inspector is running
	 * @ru Проверить, запущен ли инспектор памяти
	 * @returns True if the inspector is running
	 */
	public isRunning(): boolean {
		return this.intervalId !== null;
	}

	/**
	 * @en Count references to a module
	 * This is an approximation using the module's dependencies
	 * @ru Подсчитать ссылки на модуль
	 * Это приблизительная оценка, использующая зависимости модуля
	 * @param module - Module to count references for
	 * @returns Number of references
	 */
	private countReferences(module: Module): number {
		let count = 0;

		// Count references from other modules
		this.moduleManager.getAllModules().forEach((otherModule: Module) => {
			if (otherModule.name !== module.name) {
				// Check if this module depends on the target module
				if (otherModule.dependencies.includes(module.name)) {
					count++;
				}
			}
		});

		return count;
	}

	/**
	 * @en Analyze memory usage to detect potential leaks
	 * @ru Анализировать использование памяти для обнаружения потенциальных утечек
	 * @returns Array of memory leak results
	 */
	public analyzeMemoryUsage(): MemoryLeakResult[] {
		const results: MemoryLeakResult[] = [];

		// Analyze each module
		for (const [moduleName, snapshots] of this.snapshots.entries()) {
			// Need at least 2 snapshots to detect growth
			if (snapshots.length < 2) continue;

			// Calculate memory growth rate
			const oldestSnapshot = snapshots[0];
			const newestSnapshot = snapshots[snapshots.length - 1];
			const timeElapsedHours =
				(newestSnapshot.timestamp - oldestSnapshot.timestamp) / 1000 / 60 / 60;

			// Skip if time elapsed is too small
			if (timeElapsedHours < 0.01) continue; // At least 36 seconds

			// Calculate growth in MB per hour
			const heapGrowthMB =
				(newestSnapshot.heapUsed - oldestSnapshot.heapUsed) / 1024 / 1024;
			const growthRateMBPerHour = heapGrowthMB / timeElapsedHours;

			// Determine severity
			let severity: "low" | "medium" | "high" = "low";
			if (growthRateMBPerHour >= this.options.thresholds.high) {
				severity = "high";
			} else if (growthRateMBPerHour >= this.options.thresholds.medium) {
				severity = "medium";
			} else if (growthRateMBPerHour >= this.options.thresholds.low) {
				severity = "low";
			} else {
				// No significant growth, skip
				continue;
			}

			// Generate recommendation
			let recommendation = "Monitor memory usage over time.";
			if (severity === "high") {
				recommendation =
					"Urgent: Check for event listeners, caches, or collections that aren't being cleaned up.";
			} else if (severity === "medium") {
				recommendation =
					"Review module cleanup in onStop() method and check for retained references.";
			}

			// Add result
			results.push({
				moduleName,
				severity,
				growthRate: growthRateMBPerHour,
				snapshots,
				recommendation,
			});
		}

		// Log results if any leaks detected
		if (results.length > 0) {
			this.logger.warn(`Detected ${results.length} potential memory leaks`);

			results.forEach((result) => {
				this.logger.warn({
					message: `Potential memory leak in module ${result.moduleName}: ${result.growthRate.toFixed(2)} MB/hour (${result.severity} severity)`,
					recommendation: result.recommendation,
					moduleState: "WARNING",
				});
			});

			// Emit event
			this.emit("memoryLeakDetected", results);
		}

		return results;
	}

	/**
	 * @en Get memory snapshots for a specific module
	 * @ru Получить снимки памяти для конкретного модуля
	 * @param moduleName - Name of the module
	 * @returns Array of memory snapshots or undefined if not found
	 */
	public getModuleSnapshots(
		moduleName: string,
	): ModuleMemorySnapshot[] | undefined {
		return this.snapshots.get(moduleName);
	}

	/**
	 * @en Get all memory snapshots
	 * @ru Получить все снимки памяти
	 * @returns Map of module names to memory snapshots
	 */
	public getAllSnapshots(): Map<string, ModuleMemorySnapshot[]> {
		return new Map(this.snapshots);
	}

	/**
	 * @en Clear all snapshots
	 * @ru Очистить все снимки
	 */
	public clearSnapshots(): void {
		this.snapshots.clear();
		this.logger.info("Cleared all memory snapshots");
	}

	/**
	 * @en Generate a memory report for all modules
	 * @ru Сгенерировать отчет о памяти для всех модулей
	 * @returns Memory report object
	 */
	public generateMemoryReport(): {
		timestamp: number;
		totalHeapUsed: number;
		totalHeapTotal: number;
		moduleStats: Array<{
			moduleName: string;
			heapGrowth: number;
			growthRate: number;
			leakProbability: "none" | "low" | "medium" | "high";
		}>;
	} {
		const memoryUsage = process.memoryUsage();
		const moduleStats = [];

		for (const [moduleName, snapshots] of this.snapshots.entries()) {
			if (snapshots.length < 2) continue;

			const oldestSnapshot = snapshots[0];
			const newestSnapshot = snapshots[snapshots.length - 1];
			const timeElapsedHours =
				(newestSnapshot.timestamp - oldestSnapshot.timestamp) / 1000 / 60 / 60;

			// Skip if time elapsed is too small
			if (timeElapsedHours < 0.01) continue;

			const heapGrowth =
				(newestSnapshot.heapUsed - oldestSnapshot.heapUsed) / 1024 / 1024; // MB
			const growthRate = heapGrowth / timeElapsedHours; // MB per hour

			let leakProbability: "none" | "low" | "medium" | "high" = "none";
			if (growthRate >= this.options.thresholds.high) {
				leakProbability = "high";
			} else if (growthRate >= this.options.thresholds.medium) {
				leakProbability = "medium";
			} else if (growthRate >= this.options.thresholds.low) {
				leakProbability = "low";
			}

			moduleStats.push({
				moduleName,
				heapGrowth,
				growthRate,
				leakProbability,
			});
		}

		// Sort by growth rate (highest first)
		moduleStats.sort((a, b) => b.growthRate - a.growthRate);

		return {
			timestamp: Date.now(),
			totalHeapUsed: memoryUsage.heapUsed / 1024 / 1024, // MB
			totalHeapTotal: memoryUsage.heapTotal / 1024 / 1024, // MB
			moduleStats,
		};
	}
}

// Add global gc declaration for TypeScript
declare global {
	namespace NodeJS {
		interface Global {
			gc?: () => void;
		}
	}
}
