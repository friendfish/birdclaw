import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AutoSyncCompletedDetail,
	AutoSyncEventDetail,
	AutoSyncFailedDetail,
} from "#/components/GlobalBackgroundSync";
import { postSync } from "#/lib/api-client";
import {
	AUTO_SYNC_INTERVALS,
	autoSyncStorageKey,
	DEFAULT_AUTO_SYNC_INTERVAL_MS,
	isAccountAwareSyncKind,
	lastSyncStorageKey,
	readAutoSyncSettings,
	type StoredAutoSyncSettings,
} from "#/lib/auto-sync-keys";
import type { AccountRecord } from "#/lib/types";
import { cx, selectFieldClass } from "#/lib/ui";
import type {
	WebSyncKind,
	WebSyncOptions,
	WebSyncResponse,
} from "#/lib/web-sync";
import {
	defaultAccountId as getDefaultAccountId,
	setStoredAccountId,
	useSelectedAccountId,
} from "./account-selection";

interface SyncNowButtonProps {
	kind: WebSyncKind;
	label: string;
	accounts?: AccountRecord[];
	onSynced: (result: WebSyncResponse) => void;
	allowAutoSync?: boolean;
	showAccountPicker?: boolean;
	syncOptions?: WebSyncOptions;
	// Distinguishes independent auto-sync state (enabled flag, interval,
	// last-synced timestamp) for callers that render more than one
	// SyncNowButton for the same kind/account, e.g. Home's For You and
	// Following tabs sharing kind="timeline".
	autoSyncScope?: string;
	// Some otherwise account-aware kinds still only work for the default
	// account in certain modes, e.g. Home's For You feed: xurl can't fetch it
	// at all (only bird can), and bird only ever authenticates as one,
	// single account. Sync would fail for any other selected account, so
	// block it client-side with the same messaging already used for
	// bird-only kinds instead of letting the request fail.
	requiresDefaultAccount?: boolean;
}

interface AutoSyncSettings extends StoredAutoSyncSettings {
	key: string;
}

export function SyncNowButton({
	kind,
	label,
	accounts,
	onSynced,
	allowAutoSync = false,
	showAccountPicker = false,
	syncOptions,
	autoSyncScope,
	requiresDefaultAccount = false,
}: SyncNowButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const syncingRef = useRef(false);
	const onSyncedRef = useRef(onSynced);
	const [autoSyncing, setAutoSyncing] = useState(false);
	const [autoSyncError, setAutoSyncError] = useState<string | null>(null);
	const accountList = accounts ?? [];
	const globalAccountId = useSelectedAccountId(accounts);
	const defaultAccountId = useMemo(
		() => getDefaultAccountId(accounts),
		[accounts],
	);
	const accountId = globalAccountId ?? defaultAccountId;
	const accountAwareSync = isAccountAwareSyncKind(kind);
	// Storage keys must agree with GlobalBackgroundSync's key derivation for
	// non-account-aware kinds (currently just dms), which always checks the
	// "default" suffix regardless of which account happens to be selected —
	// otherwise settings toggled here would be written under a key the
	// driver never reads.
	const syncAccountId = accountAwareSync ? accountId : undefined;
	const [lastAutoSyncedAt, setLastAutoSyncedAtState] = useState<number | null>(
		null,
	);
	const setLastAutoSyncedAt = useCallback(
		(timestamp: number | null) => {
			setLastAutoSyncedAtState(timestamp);
			const lastSyncKey = lastSyncStorageKey(
				kind,
				syncAccountId,
				autoSyncScope,
			);
			if (timestamp === null) {
				window.localStorage.removeItem(lastSyncKey);
			} else {
				window.localStorage.setItem(lastSyncKey, String(timestamp));
			}
		},
		[kind, syncAccountId, autoSyncScope],
	);
	const autoSyncKey = autoSyncStorageKey(kind, syncAccountId, autoSyncScope);
	const [autoSettings, setAutoSettings] = useState<AutoSyncSettings>({
		key: "",
		enabled: false,
		intervalMs: DEFAULT_AUTO_SYNC_INTERVAL_MS,
	});
	const autoSettingsReady = autoSettings.key === autoSyncKey;
	const waitingForAccount =
		accountAwareSync &&
		accounts === undefined &&
		(showAccountPicker || kind !== "timeline");
	const birdOnlyWrongAccount =
		(!accountAwareSync || requiresDefaultAccount) &&
		accountId !== undefined &&
		defaultAccountId !== undefined &&
		accountId !== defaultAccountId;
	const disabled = syncing || waitingForAccount || birdOnlyWrongAccount;
	const statusMessage = birdOnlyWrongAccount
		? "Switch to default to sync"
		: waitingForAccount
			? "Loading account"
			: (error ?? message ?? "");
	const autoStatusMessage = autoSyncError
		? `Auto sync failed: ${autoSyncError}`
		: autoSyncing
			? "Auto syncing..."
			: lastAutoSyncedAt
				? `Last auto sync ${new Date(lastAutoSyncedAt).toLocaleTimeString()}`
				: autoSettings.enabled
					? "Auto sync waiting"
					: "Auto sync off";

	useEffect(() => {
		onSyncedRef.current = onSynced;
	}, [onSynced]);

	useEffect(() => {
		const stored = readAutoSyncSettings(autoSyncKey);
		setAutoSettings({ key: autoSyncKey, ...stored });
		setAutoSyncError(null);
		setAutoSyncing(false);

		const lastSyncKey = lastSyncStorageKey(kind, syncAccountId, autoSyncScope);
		const storedLastSync = window.localStorage.getItem(lastSyncKey);
		const lastSynced = storedLastSync ? Number(storedLastSync) : null;
		setLastAutoSyncedAtState(
			lastSynced && !isNaN(lastSynced) ? lastSynced : null,
		);
	}, [autoSyncKey, kind, syncAccountId, autoSyncScope]);

	function selectAccount(accountId: string) {
		setStoredAccountId(accountId);
	}

	const syncNow = useCallback(async (): Promise<boolean> => {
		if (syncingRef.current || waitingForAccount || birdOnlyWrongAccount) {
			return false;
		}
		syncingRef.current = true;
		setSyncing(true);
		setError(null);
		setMessage(null);
		try {
			const data = await postSync(kind, syncAccountId, syncOptions);
			if (!data.ok) throw new Error(data.summary);
			setLastAutoSyncedAt(Date.now());
			setMessage(data.summary);
			onSyncedRef.current(data);
			return true;
		} catch (syncError) {
			const syncMessage =
				syncError instanceof Error ? syncError.message : "Sync failed";
			setError(syncMessage);
			return false;
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}, [
		birdOnlyWrongAccount,
		kind,
		syncAccountId,
		syncOptions,
		waitingForAccount,
	]);

	// GlobalBackgroundSync is the sole executor of auto-sync; this component
	// only reflects its progress by listening for the events it dispatches.
	useEffect(() => {
		if (!allowAutoSync) return;
		const expectedAccountId = syncAccountId ?? "default";
		const matches = (detail: AutoSyncEventDetail) =>
			detail.kind === kind &&
			detail.accountId === expectedAccountId &&
			detail.scope === autoSyncScope;

		const onStarted = (event: Event) => {
			const detail = (event as CustomEvent<AutoSyncEventDetail>).detail;
			if (!matches(detail)) return;
			setAutoSyncing(true);
			setAutoSyncError(null);
		};
		const onCompleted = (event: Event) => {
			const detail = (event as CustomEvent<AutoSyncCompletedDetail>).detail;
			if (!matches(detail)) return;
			setAutoSyncing(false);
			setAutoSyncError(null);
			setLastAutoSyncedAt(detail.timestamp);
			onSyncedRef.current(detail.result);
		};
		const onFailed = (event: Event) => {
			const detail = (event as CustomEvent<AutoSyncFailedDetail>).detail;
			if (!matches(detail)) return;
			setAutoSyncing(false);
			setAutoSyncError(detail.error);
		};

		window.addEventListener("birdclaw:auto-sync-started", onStarted);
		window.addEventListener("birdclaw:auto-sync-completed", onCompleted);
		window.addEventListener("birdclaw:auto-sync-failed", onFailed);
		return () => {
			window.removeEventListener("birdclaw:auto-sync-started", onStarted);
			window.removeEventListener("birdclaw:auto-sync-completed", onCompleted);
			window.removeEventListener("birdclaw:auto-sync-failed", onFailed);
		};
	}, [allowAutoSync, kind, syncAccountId, autoSyncScope, setLastAutoSyncedAt]);

	function updateAutoSettings(next: StoredAutoSyncSettings) {
		const settings = { key: autoSyncKey, ...next };
		setAutoSettings(settings);
		window.localStorage.setItem(
			autoSyncKey,
			JSON.stringify({ enabled: next.enabled, intervalMs: next.intervalMs }),
		);
		setAutoSyncError(null);
		setLastAutoSyncedAt(null);
	}

	return (
		<div
			className={cx(
				"flex shrink-0 flex-wrap items-center justify-end gap-2",
				allowAutoSync && "w-full lg:w-auto",
			)}
		>
			{showAccountPicker && accountAwareSync && accountList.length > 1 ? (
				<select
					aria-label="Sync account"
					className={cx(selectFieldClass, "h-9 w-[132px]!")}
					disabled={syncing}
					onChange={(event) => selectAccount(event.target.value)}
					value={accountId ?? ""}
				>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.handle}
						</option>
					))}
				</select>
			) : null}
			<button
				type="button"
				className={cx(
					"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-semibold text-[var(--ink)] transition-[background,border-color,color,transform] duration-150 hover:border-[color:color-mix(in_srgb,var(--accent)_45%,var(--line))] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.98] disabled:opacity-65",
					syncing && "text-[var(--ink-soft)]",
					birdOnlyWrongAccount
						? "disabled:cursor-not-allowed"
						: "disabled:cursor-wait",
				)}
				aria-label={
					birdOnlyWrongAccount
						? `${label}: default account only`
						: syncing
							? `${label}: syncing`
							: label
				}
				disabled={disabled}
				onClick={() => void syncNow()}
			>
				<RefreshCw
					className={cx("size-4", syncing && "animate-spin")}
					strokeWidth={2}
				/>
				<span className="hidden sm:inline">
					{syncing ? "Syncing..." : label}
				</span>
			</button>
			<span
				className={cx(
					"hidden max-w-[190px] truncate text-[12px] sm:inline",
					error ? "text-[var(--alert)]" : "text-[var(--ink-soft)]",
				)}
				role="status"
			>
				{statusMessage}
			</span>
			{allowAutoSync && autoSettingsReady ? (
				<>
					<label className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)]">
						<input
							aria-label={`Auto sync ${kind}`}
							type="checkbox"
							checked={autoSettings.enabled}
							disabled={waitingForAccount || birdOnlyWrongAccount}
							onChange={(event) =>
								updateAutoSettings({
									enabled: event.currentTarget.checked,
									intervalMs: autoSettings.intervalMs,
								})
							}
						/>
						Auto sync
					</label>
					<select
						aria-label={`${label} auto-sync interval`}
						className={cx(selectFieldClass, "h-9 w-[70px]!")}
						disabled={!autoSettings.enabled}
						onChange={(event) =>
							updateAutoSettings({
								enabled: autoSettings.enabled,
								intervalMs: Number(event.currentTarget.value),
							})
						}
						value={autoSettings.intervalMs}
					>
						{AUTO_SYNC_INTERVALS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<span
						className={cx(
							"max-w-[190px] truncate text-[12px]",
							autoSyncError ? "text-[var(--alert)]" : "text-[var(--ink-soft)]",
						)}
						role="status"
					>
						{autoStatusMessage}
					</span>
				</>
			) : null}
		</div>
	);
}
