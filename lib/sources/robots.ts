/** robots.txt evaluation (RFC 9309 longest match for our agent group or `*`). Restored from the previous HTTP observer. */

export function robotsAllows(robotsTxt: string, path: string, ua = 'Signal'): boolean {
	const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
	let cur: (typeof groups)[number] | undefined;
	let lastWasAgent = false;
	for (const line of robotsTxt.split(/\r?\n/)) {
		const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		if (key === 'user-agent') {
			if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
			cur.agents.push(m[2].toLowerCase());
			lastWasAgent = true;
		} else if ((key === 'allow' || key === 'disallow') && cur) {
			lastWasAgent = false;
			if (m[2] !== '') cur.rules.push({ allow: key === 'allow', path: m[2] });
		} else lastWasAgent = false;
	}
	const mine = groups.find((g) => g.agents.some((a) => a !== '*' && ua.toLowerCase().includes(a))) ?? groups.find((g) => g.agents.includes('*'));
	if (!mine) return true;
	let best: { allow: boolean; len: number } = { allow: true, len: -1 };
	for (const r of mine.rules) {
		const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
		if (re.test(path) && (r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
	}
	return best.allow;
}
