import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(root, name), 'utf8');
const appSource = (...parts: string[]) => readFileSync(join(root, '..', '..', 'app', ...parts), 'utf8');

describe('portfolio presentational component contract', () => {
  test('exports every integration seam from one barrel', () => {
    const index = source('index.ts');
    for (const name of [
      'PortfolioHomeView',
      'PortfolioSectionView',
      'ScopeChooser',
      'ContextBanner',
      'PortfolioReturnControl',
      'PortfolioStatusCard',
      'PortfolioHomeSkeleton',
      'PortfolioSectionSkeleton',
      'ScopeChooserSkeleton',
      'PortfolioToast',
    ]) {
      assert.match(index, new RegExp(`\\b${name}\\b`));
    }
  });

  test('keeps hotel identity explicit and exposes one drill-down without chat or score UI', () => {
    const types = source('types.ts');
    const card = source('PortfolioHotelCard.tsx');
    assert.match(types, /interface PortfolioHotelCardData[\s\S]*secondaryLabel: string;[\s\S]*drilldown: PortfolioAction;/);
    assert.match(card, /<PortfolioActionControl action=\{hotel\.drilldown\} className=\{styles\.hotelCard\}>/);
    assert.equal((card.match(/<PortfolioActionControl\b/g) ?? []).length, 1);
    assert.doesNotMatch(card, /<article\b/);
    assert.match(card, /\{hotel\.secondaryLabel\}/);
    assert.doesNotMatch(card, /MessageSquare|MessageCircle|AskStaxis|score\s*[=:]/);
  });

  test('keeps dense collections, mobile selection, and announcements explicit', () => {
    const css = source('PortfolioUI.module.css');
    const primitives = source('PortfolioPrimitives.tsx');
    const home = appSource('portfolio', 'PortfolioHomeClient.tsx');
    const section = appSource('portfolio', '[section]', 'PortfolioSectionClient.tsx');

    assert.match(css, /hotelCollection\[data-view-mode='list'\] \.hotelCard[\s\S]*display: grid;[\s\S]*min-height: 76px/);
    assert.match(css, /scopeOption\[data-selected='true'\] \.scopeCheck::after[\s\S]*content: 'Selected'/);
    assert.doesNotMatch(primitives, /role=\{tone === 'critical'[\s\S]{0,120}aria-live=/);
    assert.match(primitives, /toastRegion[\s\S]*role="region" aria-label=\{label\}/);
    assert.match(home, /statusCard=\{trueEmptyPortfolio \? \{[\s\S]*title: 'No hotels to summarize'[\s\S]*label: 'No hotel data'/);
    assert.match(home, /description: hotel\.freshness\.reason \? freshnessReason\(hotel\.freshness\.reason\)/);
    assert.match(section, /acknowledgementPercent != null[\s\S]*Acknowledgement responses/);
    assert.match(section, /clearAction: hasActiveFilters \? \{ label: 'Clear filters'/);
    assert.match(section, /description: freshnessEvidence\(hotel\.freshness\)/);
    assert.match(section, /Generated \$\{readableTimestamp\(data\.generatedAt\)/);
    assert.match(section, /portfolio\.data\?\.hotels\.find/);
    for (const client of [home, section]) {
      assert.match(client, /propertyId\.localeCompare/);
      assert.match(client, /normalizeRegion\(hotel\.region\) === normalizeRegion\(region\)/);
      assert.match(client, /setPageAnnouncement\(`Showing hotel page/);
      assert.match(client, /focus(?:Home|Section)CollectionHeading\(\)/);
    }
  });

  test('keeps components props-only and free of routing, context, and network ownership', () => {
    const componentSources = readdirSync(root)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => source(name))
      .join('\n');
    assert.doesNotMatch(componentSources, /\bfetch\s*\(|useApiResource|useRouter|usePathname|useProperty|useAuth/);
  });

  test('renders at most one scope-verified Ask slot on portfolio Home', () => {
    const home = source('PortfolioHomeView.tsx');
    const client = appSource('portfolio', 'PortfolioHomeClient.tsx');
    assert.match(home, /ask\?: React\.ReactNode;/);
    assert.equal((home.match(/\{ask\}/g) ?? []).length, 1);
    assert.match(home, /\{ask \? \([\s\S]*className=\{styles\.askRegion\}[\s\S]*\) : null\}/);
    assert.match(client, /ask=\{null\}/);
    assert.match(client, /ask=\{\([\s\S]*<PortfolioChat/);
    assert.match(home, /PortfolioStatusCard/);
    assert.match(home, /PortfolioHotelCard/);
    assert.match(home, /portfolioAction\?: PortfolioAction/);
    assert.match(home, /\{portfolioAction \? \(/);
  });

  test('supports all portfolio modules through one typed section surface', () => {
    const types = source('types.ts');
    const section = source('PortfolioSectionView.tsx');
    for (const moduleId of [
      'staxis',
      'dashboard',
      'housekeeping',
      'communications',
      'maintenance',
      'inventory',
      'staff',
      'financials',
    ]) {
      assert.match(types, new RegExp(`'${moduleId}'`));
      assert.match(section, new RegExp(`${moduleId}:`));
    }
    assert.match(section, /PortfolioActionControl action=\{item\.drilldown\}/);
  });

  test('scope chooser separates roving radio state from committed activation', () => {
    const chooser = source('ScopeChooser.tsx');
    assert.match(chooser, /role=\{variant === 'dialog' \? 'dialog'/);
    assert.match(chooser, /aria-modal=/);
    assert.match(chooser, /tabIndex=\{variant === 'dialog' \? -1/);
    assert.match(chooser, /previousFocus\?\.focus/);
    assert.match(chooser, /event\.key === 'Escape'/);
    assert.match(chooser, /event\.key === 'ArrowDown'/);
    assert.match(chooser, /event\.key === 'Home'/);
    assert.match(chooser, /role="radiogroup"/);
    assert.match(chooser, /role="radio"/);
    assert.match(chooser, /const \[activeId, setActiveId\]/);
    assert.match(chooser, /aria-checked=\{selected\}/);
    assert.match(chooser, /setActiveId\(nextChoice\.id\)/);
    assert.match(chooser, /moveChoiceFocus\(choice\.id, 1\)/);
    assert.match(chooser, /event\.key === 'Enter' \|\| event\.key === ' '/);
    assert.match(chooser, /if \(!event\.repeat\) activateChoice\(choice\)/);
    assert.match(chooser, /onClick=\{\(\) => activateChoice\(choice\)\}/);
    const moveStart = chooser.indexOf('const moveChoiceFocus');
    const moveEnd = chooser.indexOf('const activateChoice', moveStart);
    assert.ok(moveStart >= 0 && moveEnd > moveStart);
    assert.doesNotMatch(chooser.slice(moveStart, moveEnd), /onSelect\(/);
  });

  test('scope chooser gives passive dialogs a focus anchor and contextual close name', () => {
    const chooser = source('ScopeChooser.tsx');
    assert.match(chooser, /const target = preferredChoice \?\? focusableWithin\(panel\)\[0\] \?\? panel/);
    assert.match(chooser, /if \(focusable\.length === 0\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*panelRef\.current\.focus/);
    assert.match(chooser, /document\.activeElement === panelRef\.current/);
    assert.match(chooser, /element\.tabIndex >= 0/);
    assert.match(chooser, /const dialogOpening = variant === 'dialog' && open/);
    assert.match(chooser, /if \(opening\) setActiveId\(selectedOrFirstId\)/);
    assert.match(chooser, /target\.focus\(\)/);
    assert.match(chooser, /closeLabel \?\? `Close \$\{title\}`/);
  });

  test('theme CSS keeps the light appearance and covers touch, motion, zoom, and contrast modes', () => {
    const css = source('PortfolioUI.module.css');
    assert.match(css, /min-height: 44px/);
    assert.match(css, /color-scheme:\s*light/);
    assert.doesNotMatch(css, /data-theme|prefers-color-scheme:\s*dark|color-scheme:\s*dark/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /prefers-contrast: more/);
    assert.match(css, /forced-colors: active/);
    assert.match(css, /@media \(max-width: 480px\)/);
    assert.match(css, /overflow-wrap: anywhere/);
    assert.match(css, /\.statusChip \{[\s\S]*flex: 0 0 auto;[\s\S]*word-break: normal;/);
    assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.hotelCardHeader \{ align-items: stretch; flex-direction: column; \}/);
    assert.match(css, /safe-area-inset-bottom/);
  });
});
