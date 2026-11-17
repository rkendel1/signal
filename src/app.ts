import { createClient } from '@feltdb/feltkit/client';
import { api } from '../feltkit/_generated/api.ts';

export { api };
export const client = createClient();
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Any = any;

/** Untyped calls keep the views short; the server validates every argument. */
export const q = (fn: unknown, args: Record<string, unknown> = {}) => client.query(fn as never, args as never) as Promise<Any>;
export const m = (fn: unknown, args: Record<string, unknown> = {}) => client.mutation(fn as never, args as never) as Promise<Any>;
export const act = (fn: unknown, args: Record<string, unknown> = {}) => client.action(fn as never, args as never) as Promise<Any>;

export function go(hash: string) { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); }
export function route(): { view: string; id: string | null; params: URLSearchParams } {
	const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
	const [view, id] = path.split('/');
	return { view: view || 'findings', id: id ? decodeURIComponent(id) : null, params: new URLSearchParams(query ?? '') };
}
