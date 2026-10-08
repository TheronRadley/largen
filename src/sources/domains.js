/**
 * Domain knowledge used to estimate source authority and type.
 * This is a heuristic prior, not a verdict: a page on a strong domain can still be weak,
 * and the page's own content is scored separately in score.js.
 * Extend these lists freely for your topics.
 */

const matchesHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

const RULES = [
  {
    type: 'government',
    authority: 25,
    test: (h) => /\.(gov|govt\.nz|gc\.ca|admin\.ch)$|\.gov\.[a-z]{2}$|\.gouv\.[a-z]{2}$|\.gob\.[a-z]{2}$|\.go\.[a-z]{2}$/.test(h),
  },
  {
    type: 'academic',
    authority: 24,
    test: (h) => /\.edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$|\.ac$/.test(h),
  },
  {
    type: 'official',
    authority: 23,
    test: (h) => /\.int$|^(docs|developer|developers|learn|support|help)\./.test(h),
    hosts: ['who.int', 'un.org', 'europa.eu', 'oecd.org', 'worldbank.org', 'imf.org', 'unesco.org', 'ipcc.ch', 'iea.org'],
  },
  {
    type: 'primary_research',
    authority: 23,
    hosts: [
      'nature.com', 'science.org', 'cell.com', 'thelancet.com', 'nejm.org', 'bmj.com', 'jamanetwork.com',
      'cochranelibrary.com', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'arxiv.org', 'doi.org',
      'plos.org', 'frontiersin.org', 'mdpi.com', 'sciencedirect.com', 'springer.com', 'wiley.com',
      'ieee.org', 'acm.org', 'pnas.org', 'annualreviews.org',
    ],
  },
  {
    type: 'standards',
    authority: 22,
    hosts: ['iso.org', 'w3.org', 'ietf.org', 'rfc-editor.org', 'ansi.org', 'iec.ch'],
  },
  {
    type: 'vendor',
    authority: 17,
    hosts: [
      'apple.com', 'microsoft.com', 'intel.com', 'amd.com', 'nvidia.com', 'samsung.com', 'dell.com',
      'lenovo.com', 'hp.com', 'asus.com', 'acer.com', 'qualcomm.com', 'msi.com', 'framework.computer',
    ],
  },
  {
    type: 'review',
    authority: 16,
    hosts: [
      'rtings.com', 'notebookcheck.net', 'tomshardware.com', 'anandtech.com', 'pcmag.com', 'theverge.com',
      'arstechnica.com', 'laptopmag.com', 'consumerreports.org', 'wirecutter.com', 'cnet.com',
      'techradar.com', 'gsmarena.com', 'pcworld.com', 'howtogeek.com', 'engadget.com',
    ],
  },
  {
    type: 'news',
    authority: 18,
    hosts: [
      'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'ft.com',
      'economist.com', 'bloomberg.com', 'wsj.com', 'aljazeera.com', 'lemonde.fr', 'washingtonpost.com',
      'npr.org', 'dw.com', 'cnbc.com', 'france24.com',
    ],
  },
  {
    type: 'reference',
    authority: 15,
    hosts: ['wikipedia.org', 'britannica.com', 'investopedia.com'],
  },
  {
    type: 'community',
    authority: 9,
    hosts: [
      'reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'medium.com', 'substack.com',
      'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'facebook.com', 'tiktok.com', 'instagram.com',
      'linkedin.com', 'pinterest.com',
    ],
  },
];

export const PRIMARY_TYPES = new Set(['government', 'academic', 'primary_research', 'official', 'standards', 'vendor']);

/**
 * @param {string} hostname
 * @param {string} [path]
 * @returns {{type: string, authority: number, isPrimary: boolean}}
 */
export function classifySourceHost(hostname, path = '') {
  const host = String(hostname ?? '').replace(/^www\./i, '').toLowerCase();
  if (!host) return { type: 'unknown', authority: 8, isPrimary: false };

  for (const rule of RULES) {
    const hit = rule.test?.(host) || rule.hosts?.some((d) => matchesHost(host, d));
    if (hit) return { type: rule.type, authority: rule.authority, isPrimary: PRIMARY_TYPES.has(rule.type) };
  }
  if (/(^|\.)blog\.|\/blog(\/|$)/i.test(`${host}${path}`)) {
    return { type: 'blog', authority: 10, isPrimary: false };
  }
  return { type: 'unknown', authority: 10, isPrimary: false };
}
