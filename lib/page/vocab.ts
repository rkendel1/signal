/**
 * Explicit vocabulary mappings (schema.org + common metadata). Deterministic tables —
 * extending coverage means adding rows here, not writing a site parser.
 */
import type { DataType } from './types.ts';

/** schema.org property → the data type its scalar values are parsed as. */
export const PROPERTY_TYPES: Record<string, DataType> = {
	price: 'money', lowPrice: 'money', highPrice: 'money', minValue: 'number', maxValue: 'number', value: 'number',
	baseSalary: 'money', salary: 'money', estimatedSalary: 'money',
	datePublished: 'datetime', dateModified: 'datetime', dateCreated: 'datetime', datePosted: 'datetime',
	validThrough: 'datetime', validFrom: 'datetime', startDate: 'datetime', endDate: 'datetime', uploadDate: 'datetime',
	priceValidUntil: 'date', birthDate: 'date', foundingDate: 'date',
	availability: 'availability',
	url: 'url', sameAs: 'url', mainEntityOfPage: 'url', contentUrl: 'url', embedUrl: 'url', applyUrl: 'url',
	image: 'image', logo: 'image', thumbnailUrl: 'image', photo: 'image',
	email: 'email',
	ratingValue: 'number', bestRating: 'number', worstRating: 'number', reviewCount: 'number', ratingCount: 'number',
	commentCount: 'number', upvoteCount: 'number', answerCount: 'number', numberOfEmployees: 'number',
	isAccessibleForFree: 'boolean'
};

/**
 * Properties whose object values are entities in their own right. The relationship
 * type is the property name (open vocabulary): offers, seller, author, publisher,
 * hiringOrganization, jobLocation, brand, manufacturer, review, comment, …
 * Any nested object with an @type also becomes an entity, whatever the property.
 */
export const ENTITY_PROPERTIES = new Set([
	'offers', 'seller', 'author', 'creator', 'publisher', 'hiringOrganization', 'jobLocation', 'brand', 'manufacturer',
	'review', 'aggregateRating', 'reviewRating', 'comment', 'suggestedAnswer', 'acceptedAnswer', 'itemListElement',
	'address', 'location', 'organizer', 'performer', 'worksFor', 'memberOf', 'parentOrganization', 'item', 'about',
	'mainEntity', 'isPartOf', 'hasPart', 'provider', 'itemOffered', 'baseSalary', 'estimatedSalary'
]);

/** Visible label text → (attribute name, optional related entity type and relationship). */
export const LABELS: Array<{ re: RegExp; attribute: string; relate?: { type: string; rel: string } }> = [
	{ re: /^(sold by|seller|vendor|merchant|sold and shipped by|ships from and sold by|store)$/i, attribute: 'seller', relate: { type: 'Organization', rel: 'seller' } },
	{ re: /^(brand|by brand|manufacturer)$/i, attribute: 'brand', relate: { type: 'Brand', rel: 'brand' } },
	{ re: /^(company|employer|hiring organization|organization|organisation)$/i, attribute: 'hiringOrganization', relate: { type: 'Organization', rel: 'hiringOrganization' } },
	{ re: /^(author|by|posted by|written by|byline|submitted by)$/i, attribute: 'author', relate: { type: 'Person', rel: 'author' } },
	{ re: /^(location|job location|where)$/i, attribute: 'location' },
	{ re: /^(salary|compensation|pay|pay range|salary range|base salary)$/i, attribute: 'compensation' },
	{ re: /^(price|now|sale price|our price|cost|price \((incl|including)[^)]*\))$/i, attribute: 'price' },
	{ re: /^(price \((excl|excluding)[^)]*\)|price before tax|net price)$/i, attribute: 'priceExcludingTax' },
	{ re: /^(number of reviews|reviews|review count|ratings)$/i, attribute: 'reviewCount' },
	{ re: /^(phone|phone number|telephone|tel\.?|call)$/i, attribute: 'telephone' },
	{ re: /^(website|web site|web|homepage|home page|site)$/i, attribute: 'website' },
	{ re: /^(e-?mail|email address)$/i, attribute: 'email' },
	{ re: /^(contact|contact us|contact information)$/i, attribute: 'contactPoint' },
	{ re: /^(was|list price|original price|msrp|regular price)$/i, attribute: 'listPrice' },
	{ re: /^(availability|status|stock)$/i, attribute: 'availability' },
	{ re: /^(published|posted|date|updated|on)$/i, attribute: 'date' },
	{ re: /^(requirements|qualifications|required skills|must have)$/i, attribute: 'requirements' },
	{ re: /^(employment type|job type|type)$/i, attribute: 'employmentType' },
	{ re: /^(rating|stars|score)$/i, attribute: 'rating' },
	{ re: /^(sku|item|model|part number|mpn|isbn|upc|gtin|ean|item number)$/i, attribute: 'sku' }
];

/** OpenGraph / meta → page attribute name. */
export const META: Record<string, { attribute: string; type: DataType }> = {
	'og:title': { attribute: 'name', type: 'text' }, 'og:description': { attribute: 'description', type: 'text' },
	'og:url': { attribute: 'url', type: 'url' }, 'og:image': { attribute: 'image', type: 'image' },
	'og:type': { attribute: 'ogType', type: 'text' }, 'og:site_name': { attribute: 'siteName', type: 'text' },
	'og:price:amount': { attribute: 'price', type: 'money' }, 'product:price:amount': { attribute: 'price', type: 'money' },
	'og:price:currency': { attribute: 'priceCurrency', type: 'text' }, 'product:price:currency': { attribute: 'priceCurrency', type: 'text' },
	'product:availability': { attribute: 'availability', type: 'availability' }, 'og:availability': { attribute: 'availability', type: 'availability' },
	'article:published_time': { attribute: 'datePublished', type: 'datetime' }, 'article:modified_time': { attribute: 'dateModified', type: 'datetime' },
	'article:author': { attribute: 'author', type: 'text' }, 'article:section': { attribute: 'articleSection', type: 'text' },
	'twitter:title': { attribute: 'name', type: 'text' }, 'twitter:description': { attribute: 'description', type: 'text' },
	'description': { attribute: 'description', type: 'text' }, 'author': { attribute: 'author', type: 'text' },
	'keywords': { attribute: 'keywords', type: 'text' }
};

/** Meta names never copied into a representation (credentials / anti-forgery tokens). */
export const SECRET_META = /csrf|xsrf|token|nonce|session|secret|key|auth/i;

/** Units → attribute (quantities such as "3 bd | 2 ba | 1,540 sqft"). Deterministic table; extend by rows. */
export const UNITS: Array<{ re: RegExp; attribute: string; unit: string }> = [
	{ re: /^(bd|bds|bed|beds|bedroom|bedrooms|br)$/i, attribute: 'numberOfBedrooms', unit: 'count' },
	{ re: /^(ba|bath|baths|bathroom|bathrooms)$/i, attribute: 'numberOfBathrooms', unit: 'count' },
	{ re: /^(sqft|sq\.? ?ft\.?|ft²|square feet)$/i, attribute: 'floorSize', unit: 'sqft' },
	{ re: /^(m²|m2|sqm|sq\.? ?m\.?|square meters|square metres)$/i, attribute: 'floorSize', unit: 'm2' },
	{ re: /^(acre|acres|ac)$/i, attribute: 'lotSize', unit: 'acre' },
	{ re: /^(rooms?)$/i, attribute: 'numberOfRooms', unit: 'count' },
	{ re: /^(floors?|stories|storeys)$/i, attribute: 'numberOfFloors', unit: 'count' },
	{ re: /^(km|kilometers|kilometres)$/i, attribute: 'distance', unit: 'km' },
	{ re: /^(mi|miles)$/i, attribute: 'distance', unit: 'mi' }
];

/** Label phrases written without a colon ("Built 1986", "No HOA", "Price cut $10,000"). */
export const PREFIX_LABELS: Array<{ re: RegExp; attribute: string; kind: 'year' | 'money' | 'zero' | 'text' }> = [
	{ re: /^(?:built|built in|year built|constructed)\s+(\d{4})$/i, attribute: 'yearBuilt', kind: 'year' },
	{ re: /^(?:established|founded|since)\s+(\d{4})$/i, attribute: 'foundingDate', kind: 'year' },
	{ re: /^(?:no hoa|hoa:?\s*(?:none|\$0(?:\.00)?))$/i, attribute: 'hoaFee', kind: 'zero' },
	{ re: /^hoa(?: fee| dues)?:?\s*(.+)$/i, attribute: 'hoaFee', kind: 'money' },
	{ re: /^(?:price (?:cut|reduced|reduction|drop)|reduced)[:\s]*(.+)$/i, attribute: 'priceReduction', kind: 'money' }
];
