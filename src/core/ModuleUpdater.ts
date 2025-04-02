import { createLogger } from "../utils/index.js";
import axios from "axios";
import fs from "fs/promises";
import path from "path";

/**
 * @en Package.json structure
 * @ru Структура package.json
 */
interface PackageJson {
	name: string;
	version: string;
	repository?: {
		type: string;
		url: string;
	};
}

/**
 * @en Result of an update check
 * @ru Результат проверки обновлений
 */
interface UpdateCheckResult {
	moduleName: string;
	currentVersion: string;
	latestVersion?: string;
	hasUpdate: boolean;
	repositoryUrl?: string;
}

/**
 * @en Handles checking for module updates
 * @ru Обрабатывает проверку обновлений модулей
 */
export class ModuleUpdater {
	private logger = createLogger("ModuleUpdater");

	/**
	 * @en Checks for updates for a module
	 * @ru Проверяет наличие обновлений для модуля
	 * @param modulePath - Path to the module directory
	 * @returns Update check result or null if check failed
	 */
	public async checkForUpdates(
		modulePath: string,
	): Promise<UpdateCheckResult | null> {
		try {
			// Check if package.json exists
			const packageJsonPath = path.join(modulePath, "package.json");

			try {
				await fs.access(packageJsonPath);
			} catch (error) {
				// Skip check if package.json doesn't exist
				if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(
						`No package.json found for module at ${modulePath}`,
					);
				}
				return null;
			}

			// Read package.json
			const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
			const packageJson: PackageJson = JSON.parse(packageJsonContent);

			// Check if repository info exists
			if (!packageJson.repository || !packageJson.repository.url) {
				if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(
						`No repository information found for module ${packageJson.name}`,
					);
				}
				return null;
			}

			// Get repository URL
			const repoUrl = this.normalizeRepositoryUrl(packageJson.repository.url);
			if (!repoUrl) {
				this.logger.warn(
					`Invalid repository URL for module ${packageJson.name}`,
				);
				return null;
			}

			// Get latest version from GitHub
			const latestVersion = await this.getLatestVersion(repoUrl);
			if (!latestVersion) {
				return {
					moduleName: packageJson.name,
					currentVersion: packageJson.version,
					hasUpdate: false,
					repositoryUrl: repoUrl,
				};
			}

			// Compare versions
			const hasUpdate =
				this.compareVersions(latestVersion, packageJson.version) > 0;

			return {
				moduleName: packageJson.name,
				currentVersion: packageJson.version,
				latestVersion,
				hasUpdate,
				repositoryUrl: repoUrl,
			};
		} catch (error) {
			this.logger.error(`Error checking for updates: ${error}`);
			return null;
		}
	}

	/**
	 * @en Normalizes repository URL to owner/repo format
	 * @ru Нормализует URL репозитория в формат owner/repo
	 * @param url - Repository URL
	 * @returns Normalized URL in owner/repo format or null if invalid
	 */
	private normalizeRepositoryUrl(url: string): string | null {
		try {
			// Support different GitHub URL formats
			// https://github.com/owner/repo.git
			// git+https://github.com/owner/repo.git
			// git@github.com:owner/repo.git

			let match;

			// Format https://github.com/owner/repo.git or git+https://github.com/owner/repo.git
			match = url.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
			if (match) return match[1];

			// Format git@github.com:owner/repo.git
			match = url.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
			if (match) return match[1];

			return null;
		} catch (error) {
			this.logger.error(`Error normalizing repository URL: ${error}`);
			return null;
		}
	}

	/**
	 * @en Gets the latest version from GitHub
	 * @ru Получает последнюю версию из GitHub
	 * @param repo - Repository in owner/repo format
	 * @returns Latest version or null if not found
	 */
	private async getLatestVersion(repo: string): Promise<string | null> {
		try {
			// Get latest release info
			const response = await axios.get(
				`https://api.github.com/repos/${repo}/releases/latest`,
				{
					headers: {
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "ModuleUpdater",
					},
				},
			);

			if (response.status === 200 && response.data && response.data.tag_name) {
				// Remove 'v' prefix from tag if present
				return response.data.tag_name.replace(/^v/, "");
			}

			return null;
		} catch (error) {
			// If no releases or error, try getting tags
			try {
				const response = await axios.get(
					`https://api.github.com/repos/${repo}/tags`,
					{
						headers: {
							Accept: "application/vnd.github.v3+json",
							"User-Agent": "ModuleUpdater",
						},
					},
				);

				if (
					response.status === 200 &&
					response.data &&
					response.data.length > 0
				) {
					// Use first tag as latest version
					return response.data[0].name.replace(/^v/, "");
				}

				return null;
			} catch (innerError) {
				if (process.env.LOG_LEVEL === "debug") {
					this.logger.debug(`Error fetching tags for ${repo}: ${innerError}`);
				}
				return null;
			}
		}
	}

	/**
	 * @en Compares semantic versions
	 * @ru Сравнивает семантические версии
	 * @param v1 - First version
	 * @param v2 - Second version
	 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
	 */
	public compareVersions(v1: string, v2: string): number {
		const parts1 = v1.split(".").map(Number);
		const parts2 = v2.split(".").map(Number);

		for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
			const part1 = i < parts1.length ? parts1[i] : 0;
			const part2 = i < parts2.length ? parts2[i] : 0;

			if (part1 > part2) return 1;
			if (part1 < part2) return -1;
		}

		return 0;
	}
}
