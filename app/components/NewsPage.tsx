import React, { useState, useEffect } from 'react';
import { Newspaper, X, Star, Github, FileText } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import newsData from '../data/news.json';

type TabId = 'news' | 'changelog';

interface NewsLink {
  label: string;
  url: string;
}

type LocalizedString = string | Record<string, string>;

interface NewsItem {
  id: string;
  date: string;
  title: LocalizedString;
  body: LocalizedString;
  tags: string[];
  links?: NewsLink[];
}

// ── Changelog parser ─────────────────────────────────────────────────

interface ChangelogEntry {
  date: string;
  sections: { title: string; items: string[] }[];
}

function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentSection: { title: string; items: string[] } | null = null;

  for (const line of raw.split('\n')) {
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      if (current) entries.push(current);
      current = { date: dateMatch[1], sections: [] };
      currentSection = null;
      continue;
    }

    const sectionMatch = line.match(/^### (.+)/);
    if (sectionMatch && current) {
      currentSection = { title: sectionMatch[1], items: [] };
      current.sections.push(currentSection);
      continue;
    }

    const itemMatch = line.match(/^- (.+)/);
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1]);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function sectionColor(title: string): string {
  switch (title.toLowerCase()) {
    case 'added': return 'text-green-400';
    case 'changed': return 'text-amber-400';
    case 'fixed': return 'text-blue-400';
    case 'removed': return 'text-red-400';
    default: return 'text-zinc-400';
  }
}

function sectionBadgeColor(title: string): string {
  switch (title.toLowerCase()) {
    case 'added': return 'bg-green-500/15 text-green-600 dark:text-green-400';
    case 'changed': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'fixed': return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'removed': return 'bg-red-500/15 text-red-600 dark:text-red-400';
    default: return 'bg-zinc-200 dark:bg-white/10 text-zinc-500';
  }
}

// ── Changelog Tab ────────────────────────────────────────────────────

const ChangelogTab: React.FC = () => {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/changelog')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load');
        return res.text();
      })
      .then(raw => {
        setEntries(parseChangelog(raw));
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="text-center py-16">
        <div className="animate-spin w-6 h-6 border-2 border-zinc-400 border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-sm text-zinc-500">{t('changelogLoading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {entries.map((entry, i) => (
        <div
          key={entry.date}
          className="rounded-2xl border bg-white dark:bg-suno-card border-zinc-200 dark:border-white/5"
        >
          <div className="p-5 sm:p-6">
            {/* Date header */}
            <div className="flex items-center gap-3 mb-4">
              <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {entry.date}
              </span>
              {i === 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
                  {t('changelogLatest')}
                </span>
              )}
            </div>

            {/* Sections */}
            <div className="space-y-3">
              {entry.sections.map(section => (
                <div key={section.title}>
                  <span className={`text-xs font-semibold uppercase tracking-wider ${sectionColor(section.title)}`}>
                    {section.title}
                  </span>
                  <ul className="mt-1.5 space-y-1">
                    {section.items.map((item, j) => (
                      <li key={j} className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed flex gap-2">
                        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${sectionBadgeColor(section.title).split(' ')[0]}`} />
                        <span dangerouslySetInnerHTML={{
                          __html: item
                            .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-200 font-medium">$1</strong>')
                            .replace(/`(.+?)`/g, '<code class="text-xs bg-white/5 px-1 py-0.5 rounded text-zinc-300">$1</code>')
                        }} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Main NewsPage ────────────────────────────────────────────────────

export const NewsPage: React.FC = () => {
  const { t, language } = useI18n();
  const [activeTab, setActiveTab] = useState<TabId>('news');

  const localize = (value: LocalizedString): string => {
    if (typeof value === 'string') return value;
    return value[language] || value['en'] || Object.values(value)[0] || '';
  };

  const [dismissedNews, setDismissedNews] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('ace-dismissed-news');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const allNews = newsData as NewsItem[];
  const activeNews = allNews.filter(n => !dismissedNews.has(n.id));
  const dismissed = allNews.filter(n => dismissedNews.has(n.id));

  const dismissNewsItem = (id: string) => {
    setDismissedNews(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem('ace-dismissed-news', JSON.stringify([...next]));
      return next;
    });
  };

  const restoreNewsItem = (id: string) => {
    setDismissedNews(prev => {
      const next = new Set(prev);
      next.delete(id);
      localStorage.setItem('ace-dismissed-news', JSON.stringify([...next]));
      return next;
    });
  };

  const tagColor = (tag: string) => {
    switch (tag) {
      case 'experimental': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
      case 'backend': return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
      case 'training': return 'bg-purple-500/15 text-purple-600 dark:text-purple-400';
      case 'release': return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
      case 'feature': return 'bg-green-500/15 text-green-600 dark:text-green-400';
      case 'bugfix': return 'bg-red-500/15 text-red-600 dark:text-red-400';
      default: return 'bg-zinc-200 dark:bg-white/10 text-zinc-500 dark:text-zinc-400';
    }
  };

  const renderCard = (item: NewsItem, isDismissed: boolean) => (
    <div
      key={item.id}
      className={`
        group rounded-2xl border transition-all duration-200
        ${isDismissed
          ? 'bg-zinc-100 dark:bg-white/[0.02] border-zinc-200 dark:border-white/5 opacity-50'
          : 'bg-white dark:bg-suno-card border-zinc-200 dark:border-white/5 hover:border-zinc-300 dark:hover:border-white/10'
        }
      `}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
              {localize(item.title)}
            </h3>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{item.date}</p>
          </div>
          {!isDismissed ? (
            <button
              onClick={() => dismissNewsItem(item.id)}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/10 transition-all flex-shrink-0"
              title={t('dismiss')}
            >
              <X size={16} />
            </button>
          ) : (
            <button
              onClick={() => restoreNewsItem(item.id)}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline transition-colors flex-shrink-0"
            >
              {t('restore')}
            </button>
          )}
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-3 leading-relaxed whitespace-pre-line">
          {(() => {
            const text = localize(item.body);
            const parts: React.ReactNode[] = [];
            // Match https:// URLs OR bare domains (dalink.to/...) to make them clickable.
            const re = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\/[^\s]+)/g;
            let last = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              if (m.index > last) parts.push(text.slice(last, m.index));
              const url = m[0];
              const href = /^https?:\/\//.test(url) ? url : `https://${url}`;
              parts.push(
                <a key={m.index} href={href} target="_blank" rel="noopener noreferrer"
                   className="text-blue-600 dark:text-blue-400 hover:underline break-all">
                  {url}
                </a>
              );
              last = m.index + url.length;
            }
            if (last < text.length) parts.push(text.slice(last));
            return parts;
          })()}
        </p>

        {item.links && item.links.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {item.links.map(link => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
              >
                {link.label}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-4">
          {item.tags.map(tag => (
            <span
              key={tag}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${tagColor(tag)}`}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 bg-white dark:bg-black overflow-y-auto p-6 lg:p-10 pb-32 transition-colors duration-300">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <Newspaper size={20} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">{t('news')}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('newsSubtitle')}</p>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex gap-1 mb-6">
          <button
            onClick={() => setActiveTab('news')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'news'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            <Newspaper size={14} />
            {t('news')}
          </button>
          <button
            onClick={() => setActiveTab('changelog')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'changelog'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            <FileText size={14} />
            {t('changelog')}
          </button>
        </div>

        {/* Star Repo */}
        <a
          href="https://github.com/timoncool/ACE-Step-Studio"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 mb-6 px-5 py-4 rounded-2xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-suno-card hover:border-zinc-300 dark:hover:border-white/10 transition-all group"
        >
          <Github size={20} className="text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">timoncool/ACE-Step-Studio</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('starRepo')}</p>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-white/10 text-zinc-700 dark:text-zinc-300 text-sm font-medium group-hover:bg-amber-500/15 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors flex-shrink-0">
            <Star size={14} />
            Star
          </div>
        </a>

        {/* Tab Content */}
        {activeTab === 'news' && (
          <>
            {activeNews.length > 0 ? (
              <div className="space-y-4">
                {activeNews.map(item => renderCard(item, false))}
              </div>
            ) : (
              <div className="text-center py-16">
                <Newspaper size={48} className="mx-auto text-zinc-300 dark:text-zinc-600 mb-4" />
                <p className="text-zinc-500 dark:text-zinc-400 text-sm">{t('noNewUpdates')}</p>
              </div>
            )}

            {dismissed.length > 0 && (
              <div className="mt-10">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-4">
                  {t('dismissed')}
                </h2>
                <div className="space-y-3">
                  {dismissed.map(item => renderCard(item, true))}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'changelog' && <ChangelogTab />}
      </div>
    </div>
  );
};
