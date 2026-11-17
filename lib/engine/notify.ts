/**
 * Notification rules (pure). Notices are created from meaningful events only — a finding event (never an
 * observation update), a source failing or recovering, a source going stale — filtered by the person's
 * preferences and the criteria's own `notifyOn`, and deduplicated by a key so the same event never notifies twice.
 */
import type { CriteriaDefinition, Transition } from './criteria.ts';

export type NoticeKind = 'finding_new' | 'finding_changed' | 'finding_resolved' | 'finding_reopened' | 'finding_closed' | 'source_failure' | 'source_recovered' | 'source_stale' | 'monitor';
export type Severity = 'info' | 'warning' | 'critical';

export interface NotificationPrefs {
	/** Below this severity nothing is shown as a browser notification (it is still in the inbox). */
	minSeverity: Severity;
	kinds: Record<NoticeKind, boolean>;
	/** Notify about "possible" findings (evidence missing) too. */
	includePossible: boolean;
	/** Browser notifications from the extension while the browser runs. */
	browser: boolean;
	/** Show related findings in the overlay when you are on a page about the same thing. */
	contextual: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
	minSeverity: 'info',
	kinds: { finding_new: true, finding_changed: true, finding_resolved: true, finding_reopened: true, finding_closed: false, source_failure: true, source_recovered: true, source_stale: true, monitor: true },
	includePossible: false,
	browser: true,
	contextual: true,
};

export function normalizePrefs(p: Partial<NotificationPrefs> | null | undefined): NotificationPrefs {
	return { ...DEFAULT_PREFS, ...(p ?? {}), kinds: { ...DEFAULT_PREFS.kinds, ...(p?.kinds ?? {}) } };
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
export const atLeast = (s: Severity, min: Severity) => RANK[s] >= RANK[min];

const KIND: Record<string, NoticeKind> = { new: 'finding_new', changed: 'finding_changed', resolved: 'finding_resolved', reopened: 'finding_reopened', superseded: 'finding_closed', invalid: 'finding_closed' };

/** Should this finding event become a notice for this person? */
export function findingNotice(event: string, qualification: 'match' | 'possible', crit: CriteriaDefinition, prefs: NotificationPrefs): NoticeKind | null {
	const kind = KIND[event];
	if (!kind || !prefs.kinds[kind]) return null;
	// The criteria author chose what is worth announcing for these criteria; the person chose what reaches them.
	const crt = (crit.notifyOn ?? ['new', 'reopened', 'changed', 'resolved']) as Transition[];
	if (!crt.includes(event as Transition)) return null;
	if (qualification === 'possible' && !(crit.notifyPossible || prefs.includePossible)) return null;
	return kind;
}
