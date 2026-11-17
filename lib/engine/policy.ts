/**
 * Attributes Signal refuses to map or to use in criteria.
 *
 * Signal's first application is real estate, where the U.S. Fair Housing Act prohibits decisions based on
 * race, color, religion, sex, national origin, familial status or disability (many states add source of
 * income, sexual orientation, age, marital status). Demographic composition of an area is a common proxy.
 * This deny-list on attribute and column names stops the obvious cases and documents the policy; it cannot
 * detect every proxy. See FAIR_HOUSING_REVIEW.md.
 */
const WORDS = new Set([
	'race', 'racial', 'ethnicity', 'ethnic', 'religion', 'religious', 'sex', 'gender', 'nationality', 'citizenship', 'immigration',
	'immigrant', 'ancestry', 'children', 'pregnancy', 'pregnant', 'disability', 'disabled', 'handicap', 'handicapped', 'age',
	'demographic', 'demographics', 'minority', 'minorities', 'hispanic', 'latino', 'latina', 'black', 'white', 'asian',
]);
const PHRASES = ['nationalorigin', 'familialstatus', 'familystatus', 'sourceofincome', 'sexualorientation', 'maritalstatus', 'skincolor'];

/** The protected term an attribute name refers to, or null. */
export function protectedTerm(name: string): string | null {
	const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
	for (const w of words) if (WORDS.has(w)) return w;
	const joined = words.join('');
	return PHRASES.find((p) => joined.includes(p)) ?? null;
}

export function assertPermittedAttribute(name: string, where: string): void {
	const t = protectedTerm(name);
	if (t) throw new Error(`${where}: "${name}" refers to a protected characteristic (${t}); Signal does not map or evaluate it (FAIR_HOUSING_REVIEW.md)`);
}
