import {
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  FileSearch,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  MoreHorizontal,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Route,
  Search,
  Server,
  Settings,
  Sun,
  UserPlus,
} from 'lucide-react';
import {
  FormEvent,
  forwardRef,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  ApiKey,
  ActivityLog,
  ActivityLogStatus,
  ActivitySummary,
  DashboardData,
  ModelAlias,
  Provider,
  SectionKey,
  Usage as UsageResponse,
  UsageGroup,
  User,
} from './api';

type Tab = 'overview' | 'keys' | 'providers' | 'aliases' | 'usage' | 'activity' | 'settings';
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'off';
type SortDir = 'asc' | 'desc';
type SortState = { key: string; dir: SortDir };
type Toast = { tone: Tone; message: string; persistent?: boolean } | null;
type ActivityItem = { id: string; at: Date; tone: Tone; label: string };
type LoadStatus = 'idle' | 'loading' | 'current' | 'stale' | 'failed';
type SectionState = { status: LoadStatus; lastLoadedAt: Date | null; error?: string };
type SectionStates = Record<SectionKey, SectionState>;
type UsageTab = 'users' | 'teams' | 'models' | 'keys' | 'attribution';
type UsageMetric = 'estimatedCost' | 'totalTokens' | 'requests' | 'errors';
type ThemeMode = 'system' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';
type PendingAction =
  | { kind: 'provider-health'; id: string }
  | { kind: 'provider-rotate'; id: string }
  | { kind: 'provider-disable'; id: string }
  | { kind: 'alias-sync'; id: string }
  | { kind: 'alias-disable'; id: string }
  | { kind: 'key-revoke'; id: string }
  | { kind: 'usage-refresh' };
type ModalState =
  | null
  | {
      kind: 'danger';
      title: string;
      body: ReactNode;
      label: string;
      confirmText: string;
      success: string;
      action: () => Promise<void>;
      pending?: PendingAction;
    }
  | { kind: 'rotate'; provider: Provider; affectedAliases: number }
  | { kind: 'details'; title: string; body: ReactNode };

const emptyData: DashboardData = {
  users: [],
  providers: [],
  aliases: [],
  keys: [],
  usage: null,
  nextCursors: {},
};
const tokenKey = 'tlg_admin_token';
const sidebarCollapsedKey = 'tlg_sidebar_collapsed';
const themeKey = 'tlg_theme';
const sectionKeys: SectionKey[] = ['users', 'providers', 'aliases', 'keys', 'usage'];
const emptySectionStates = Object.fromEntries(
  sectionKeys.map((section) => [section, { status: 'idle', lastLoadedAt: null }]),
) as SectionStates;

const nav: Array<{ id: Tab; label: string; description: string; icon: ReactNode }> = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'System health, routing status, and operator actions.',
    icon: <LayoutDashboard />,
  },
  {
    id: 'keys',
    label: 'Users & Keys',
    description: 'Create developers and issue developer keys.',
    icon: <KeyRound />,
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Manage upstream providers and credentials.',
    icon: <Server />,
  },
  {
    id: 'aliases',
    label: 'Model Aliases',
    description: 'Map stable public model names to upstream providers.',
    icon: <Route />,
  },
  {
    id: 'usage',
    label: 'Usage',
    description: 'Monitor request volume, token usage, cost, and attribution.',
    icon: <BarChart3 />,
  },
  {
    id: 'activity',
    label: 'Activity Logs',
    description: 'Inspect admin-only AI activity by user, project, model, and client.',
    icon: <FileSearch />,
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Operator notes, client configuration, and session controls.',
    icon: <Settings />,
  },
];

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(sidebarCollapsedKey) === 'true',
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(getSystemTheme);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [errors, setErrors] = useState<Partial<Record<SectionKey, string>>>({});
  const [sectionStates, setSectionStates] = useState<SectionStates>(emptySectionStates);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const autoLoadStarted = useRef(false);
  const current = nav.find((item) => item.id === tab)!;
  const hasLoaded = Boolean(lastRefresh);
  const hasFailures = Object.keys(errors).length > 0;

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const next = themeMode === 'system' ? getSystemTheme() : themeMode;
      setResolvedTheme(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.dataset.themeMode = themeMode;
      document.documentElement.style.colorScheme = next;
      localStorage.setItem(themeKey, themeMode);
    };

    applyTheme();
    if (themeMode !== 'system') return;

    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themeMode]);

  const addActivity = (label: string, tone: Tone = 'info') => {
    setActivity((items) =>
      [{ id: crypto.randomUUID(), at: new Date(), tone, label }, ...items].slice(0, 8),
    );
  };

  const notify = (message: string, tone: Tone = 'ok') => {
    setToast({ message, tone, persistent: tone === 'danger' });
    window.clearTimeout(window.__loomToastTimer);
    if (tone !== 'danger') {
      window.__loomToastTimer = window.setTimeout(
        () => setToast(null),
        tone === 'warn' ? 7000 : 4200,
      );
    }
  };

  const updateToken = (value: string) => {
    setToken(value);
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(tokenKey, trimmed);
    } else {
      localStorage.removeItem(tokenKey);
    }
  };

  const refresh = async () => {
    if (!token.trim()) {
      notify('Enter the admin token before loading dashboard data.', 'warn');
      return;
    }
    setLoading(true);
    setSectionStates(
      (states) =>
        Object.fromEntries(
          sectionKeys.map((section) => [
            section,
            { ...states[section], status: 'loading', error: undefined },
          ]),
        ) as SectionStates,
    );
    localStorage.setItem(tokenKey, token.trim());
    try {
      const result = await api.getDashboard(token.trim());
      const loadedAt = new Date();
      setData((previous) => ({
        users: result.errors.users ? previous.users : result.data.users,
        providers: result.errors.providers ? previous.providers : result.data.providers,
        aliases: result.errors.aliases ? previous.aliases : result.data.aliases,
        keys: result.errors.keys ? previous.keys : result.data.keys,
        usage: result.errors.usage ? previous.usage : result.data.usage,
        nextCursors: {
          ...previous.nextCursors,
          ...Object.fromEntries(
            (['users', 'providers', 'aliases', 'keys'] as const)
              .filter((section) => !result.errors[section])
              .map((section) => [section, result.data.nextCursors[section]]),
          ),
        },
      }));
      setSectionStates((previous) => {
        const next = { ...previous };
        sectionKeys.forEach((section) => {
          const message = result.errors[section];
          if (message) {
            next[section] = {
              status: hasSectionData(section, data) ? 'stale' : 'failed',
              lastLoadedAt: previous[section].lastLoadedAt,
              error: message,
            };
          } else {
            next[section] = { status: 'current', lastLoadedAt: loadedAt };
          }
        });
        return next;
      });
      setErrors(result.errors);
      setLastRefresh(loadedAt);
      const failed = Object.keys(result.errors).length;
      notify(
        failed
          ? `Dashboard loaded with ${failed} failed section${failed === 1 ? '' : 's'}.`
          : 'Dashboard loaded.',
        failed ? 'warn' : 'ok',
      );
      addActivity(
        failed
          ? `Dashboard loaded with ${failed} failed section${failed === 1 ? '' : 's'}`
          : 'Dashboard loaded',
        failed ? 'warn' : 'ok',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dashboard load failed.';
      setSectionStates(
        (states) =>
          Object.fromEntries(
            sectionKeys.map((section) => [
              section,
              {
                ...states[section],
                status: hasSectionData(section, data) ? 'stale' : 'failed',
                error: message,
              },
            ]),
          ) as SectionStates,
      );
      notify(`Dashboard load failed. Check the admin API and retry. ${message}`, 'danger');
      addActivity('Dashboard load failed', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (autoLoadStarted.current || !token.trim()) return;
    autoLoadStarted.current = true;
    void refresh();
  }, []);

  const run = async (
    action: () => Promise<void>,
    success: string,
    tone: Tone = 'ok',
    pending?: PendingAction,
  ) => {
    if (pending) setPendingAction(pending);
    try {
      await action();
      notify(success, tone);
      addActivity(success, tone);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed.';
      notify(
        `${success.replace(/\.$/, '')} failed. Check the object state and retry. ${message}`,
        'danger',
      );
      addActivity(message, 'danger');
    } finally {
      if (pending) setPendingAction(null);
    }
  };

  const clearSession = () => {
    localStorage.removeItem(tokenKey);
    setToken('');
    setData(emptyData);
    setErrors({});
    setSectionStates(emptySectionStates);
    setLastRefresh(null);
    notify('Token cleared. Dashboard data removed from this browser.', 'warn');
    addActivity('Token cleared', 'warn');
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(sidebarCollapsedKey, String(next));
      return next;
    });
  };

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Admin navigation">
        <div className="sidebar-head">
          <div className="brand">
            <h1>Loom Admin</h1>
            <p>Internal LLM gateway control plane for providers, aliases, keys, and usage.</p>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
        <nav className="nav" aria-label="Admin sections">
          {nav.map((item) => (
            <button
              key={item.id}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              title={sidebarCollapsed ? item.label : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="shell">
        <header className="topbar">
          <div className="title">
            <h2>{current.label}</h2>
            <p>{current.description}</p>
          </div>
          <div className="session">
            <ThemeControl mode={themeMode} resolvedTheme={resolvedTheme} setMode={setThemeMode} />
            <DashboardStatusBadge
              token={token}
              loading={loading}
              hasLoaded={hasLoaded}
              hasFailures={hasFailures}
            />
            <Button
              tone="primary"
              icon={<RefreshCw />}
              onClick={refresh}
              disabled={loading}
              loading={loading}
            >
              {loading ? 'Loading dashboard' : hasLoaded ? 'Reload dashboard' : 'Load dashboard'}
            </Button>
            <AdminSessionMenu token={token} updateToken={updateToken} lastRefresh={lastRefresh} />
          </div>
        </header>

        <main className="content">
          {tab === 'overview' && (
            <Overview
              data={data}
              loading={loading}
              lastRefresh={lastRefresh}
              errors={errors}
              sectionStates={sectionStates}
              onRetry={refresh}
              activity={activity}
            />
          )}
          {tab === 'keys' && (
            <Keys
              data={data}
              errors={errors}
              token={token}
              run={run}
              notify={notify}
              setModal={setModal}
              pendingAction={pendingAction}
              onRetry={refresh}
            />
          )}
          {tab === 'providers' && (
            <Providers
              data={data}
              errors={errors}
              token={token}
              run={run}
              setModal={setModal}
              pendingAction={pendingAction}
              onRetry={refresh}
            />
          )}
          {tab === 'aliases' && (
            <Aliases
              data={data}
              errors={errors}
              token={token}
              run={run}
              setModal={setModal}
              pendingAction={pendingAction}
              onRetry={refresh}
            />
          )}
          {tab === 'usage' && (
            <Usage
              data={data}
              errors={errors}
              token={token}
              notify={notify}
              pendingAction={pendingAction}
              setPendingAction={setPendingAction}
              onRetry={refresh}
            />
          )}
          {tab === 'activity' && <ActivityLogs token={token} notify={notify} data={data} />}
          {tab === 'settings' && (
            <SettingsView token={token} clearSession={clearSession} notify={notify} />
          )}
        </main>
      </div>

      {modal && <Modal modal={modal} token={token} run={run} close={() => setModal(null)} />}
      {toast && <ToastView toast={toast} close={() => setToast(null)} />}
    </div>
  );
}

function Overview({
  data,
  loading,
  lastRefresh,
  errors,
  sectionStates,
  onRetry,
  activity,
}: {
  data: DashboardData;
  loading: boolean;
  lastRefresh: Date | null;
  errors: Partial<Record<SectionKey, string>>;
  sectionStates: SectionStates;
  onRetry: () => void;
  activity: ActivityItem[];
}) {
  const enabledProviders = data.providers.filter((provider) => provider.enabled).length;
  const enabledAliases = data.aliases.filter((alias) => alias.enabled).length;
  const activeKeys = data.keys.filter((key) => key.status === 'active').length;
  const unhealthy = data.providers.some((provider) => provider.healthStatus === 'unhealthy');
  const healthy = data.providers.some((provider) => provider.healthStatus === 'healthy');
  const providerTone: Tone = unhealthy
    ? 'danger'
    : healthy
      ? 'ok'
      : data.providers.length
        ? 'info'
        : 'warn';
  const providerLabel = unhealthy
    ? 'Unhealthy'
    : healthy
      ? 'Healthy'
      : data.providers.length
        ? 'Unchecked'
        : 'No providers configured';
  const failedSections = Object.entries(errors);
  const readiness = getGatewayReadiness({
    failedSections: failedSections.length,
    enabledProviders,
    enabledAliases,
    activeKeys,
    unhealthy,
    lastRefresh,
  });

  return (
    <>
      {failedSections.length > 0 && (
        <div className="inline-error">
          <strong>Some dashboard data failed to load.</strong>
          <p>
            Loaded sections may be current, but failed sections are showing stale or missing data.
          </p>
          {failedSections.map(([section, message]) => (
            <div className="error-row" key={section}>
              <span>
                <strong>{titleCase(section)}</strong>: {message}
              </span>
              <Button tone="utility" onClick={onRetry}>
                Retry section
              </Button>
            </div>
          ))}
        </div>
      )}
      <section className="hero-status">
        <div>
          <Badge tone={readiness.tone}>{readiness.badge}</Badge>
          <h3>{readiness.title}</h3>
          <p>{readiness.description}</p>
        </div>
        <Button tone="primary" icon={<RefreshCw />} onClick={onRetry} disabled={loading}>
          {loading ? 'Loading dashboard' : readiness.action}
        </Button>
      </section>
      <div className="grid three">
        <Metric
          label="Enabled providers"
          value={enabledProviders}
          badge={<Badge tone={providerTone}>{providerLabel}</Badge>}
        />
        <Metric
          label="Enabled model aliases"
          value={enabledAliases}
          badge={
            <Badge tone={enabledAliases ? 'ok' : 'warn'}>
              {enabledAliases ? 'Enabled' : 'Unchecked'}
            </Badge>
          }
        />
        <Metric
          label="Active developer keys"
          value={activeKeys}
          badge={<Badge tone={activeKeys ? 'ok' : 'off'}>{activeKeys ? 'Active' : 'None'}</Badge>}
        />
      </div>
      <div className="grid two stack">
        <Panel
          title="Gateway Status"
          subtitle="A quick read on whether the admin console can reach the control-plane data."
        >
          <StatusLine
            label="Control plane API"
            value={
              lastRefresh ? (failedSections.length ? 'Some data failed' : 'Current') : 'Not loaded'
            }
            tone={failedSections.length ? 'warn' : lastRefresh ? 'ok' : 'warn'}
          />
          <StatusLine
            label="Providers configured"
            value={enabledProviders ? `${enabledProviders} Enabled` : 'None yet'}
            tone={enabledProviders ? 'ok' : 'warn'}
          />
          <StatusLine
            label="Model aliases"
            value={enabledAliases ? `${enabledAliases} Enabled` : 'None yet'}
            tone={enabledAliases ? 'ok' : 'warn'}
          />
          <StatusLine
            label="Developer keys"
            value={activeKeys ? `${activeKeys} Active` : 'No active keys'}
            tone={activeKeys ? 'ok' : 'info'}
          />
          <div className="section-state-list">
            {sectionKeys.map((section) => (
              <div className="section-state" key={section}>
                <span>{titleCase(section)}</span>
                <Badge tone={sectionTone(sectionStates[section].status)}>
                  {sectionLabel(sectionStates[section].status)}
                </Badge>
              </div>
            ))}
          </div>
          <div className="meta-line">
            {loading
              ? 'Loading dashboard data...'
              : `Last loaded: ${lastRefresh ? formatRelativeDate(lastRefresh) : 'Never'}`}
          </div>
        </Panel>
        <Panel
          title="Operator Runbook"
          subtitle="Shortest path from empty system to working developer access."
        >
          <div className="callout info">
            1. Add provider and run health check.
            <br />
            2. Create model aliases and sync them.
            <br />
            3. Create developer user and issue a developer key.
            <br />
            4. Test client tooling against <code>code-premium</code>.
          </div>
        </Panel>
      </div>
      <Panel
        className="stack"
        title="Recent Activity"
        subtitle="Session-local operator actions and refresh results."
      >
        {activity.length ? (
          <div className="activity-list">
            {activity.map((item) => (
              <div className="activity-item" key={item.id}>
                <Badge tone={item.tone}>{item.tone}</Badge>
                <span>{item.label}</span>
                <span className="hint">{formatDate(item.at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No actions recorded in this browser session.</div>
        )}
      </Panel>
    </>
  );
}

function Keys({
  data,
  errors,
  token,
  run,
  notify,
  setModal,
  pendingAction,
  onRetry,
}: {
  data: DashboardData;
  errors: Partial<Record<SectionKey, string>>;
  token: string;
  run: (
    action: () => Promise<void>,
    success: string,
    tone?: Tone,
    pending?: PendingAction,
  ) => Promise<void>;
  notify: (message: string, tone?: Tone) => void;
  setModal: (modal: ModalState) => void;
  pendingAction: PendingAction | null;
  onRetry: () => void;
}) {
  const [filters, setFilters] = useState({ q: '', status: 'all' });
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', dir: 'desc' });
  const [keys, setKeys] = useState(data.keys);
  const [nextCursor, setNextCursor] = useState<string | null>(data.nextCursors.keys ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setKeys(data.keys);
    setNextCursor(data.nextCursors.keys ?? null);
  }, [data.keys, data.nextCursors.keys]);
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.getKeys(token, nextCursor);
      setKeys((items) => [...items, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  };
  const rows = useRows(keys, filters, sort, [
    'name',
    'prefix',
    (key) => key.user?.email || data.users.find((user) => user.id === key.userId)?.email,
    (key) => key.user?.name || data.users.find((user) => user.id === key.userId)?.name,
    (key) => key.team?.name || key.team?.slug,
    'status',
    'litellmKeyAlias',
  ]);
  const [newKey, setNewKey] = useState<{ value: string; developer: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const name = String(form.get('name') || '').trim();
    const teamSlug = String(form.get('teamSlug') || '').trim();
    const teamName = String(form.get('teamName') || '').trim();
    if (!email || !name) return notify('Email and name are required.', 'warn');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return notify('Use a valid email address.', 'warn');
    await run(
      () =>
        api
          .createUser(token, {
            email,
            name,
            team: teamSlug ? { slug: teamSlug, name: teamName || teamSlug } : undefined,
          })
          .then(() => undefined),
      `Developer created: ${email}.`,
    );
    event.currentTarget.reset();
  };

  const createKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const userId = String(form.get('userId') || '');
    const name = String(form.get('name') || '').trim();
    if (!userId || !name) return notify('Developer and key name are required.', 'warn');
    const developer = data.users.find((user) => user.id === userId);
    try {
      const key = await api.createKey(token, { userId, name });
      setNewKey({ value: key.apiKey, developer: developer?.email || userId });
      setCopiedKey(false);
      notify(`Developer key issued for ${developer?.email || userId}.`);
    } catch (error) {
      notify(
        `Developer key issue failed. Check the selected developer, then retry. ${
          error instanceof Error ? error.message : ''
        }`,
        'danger',
      );
    }
  };

  return (
    <>
      <SectionErrors errors={errors} sections={['users', 'keys']} onRetry={onRetry} />
      {newKey && (
        <OneTimeSecretPanel
          value={newKey.value}
          copied={copiedKey}
          setCopied={setCopiedKey}
          notify={notify}
          dismiss={() => setNewKey(null)}
        />
      )}
      <Panel
        title="Issue developer key"
        subtitle="Developer keys are LiteLLM virtual keys. Each key belongs to one developer and should be stored in their secret manager."
      >
        <div className="flow-grid">
          <form className="form-grid flow-card primary-flow" onSubmit={createKey}>
            <div className="flow-heading full">
              <Badge tone="info">Primary</Badge>
              <strong>Issue access</strong>
              <span>Select a developer, then issue a key that can use enabled aliases.</span>
            </div>
            <div className="field full">
              <span>Developer *</span>
              <SearchableSelect
                name="userId"
                placeholder={data.users.length ? 'Select developer' : 'Create a developer first'}
                options={data.users.map((user) => ({
                  value: user.id,
                  label: user.email,
                  description: [user.name, user.team?.name || user.team?.slug]
                    .filter(Boolean)
                    .join(' • '),
                }))}
              />
            </div>
            <Field label="Key Name" name="name" required defaultValue="codex" />
            <div className="actions full">
              <Button tone="primary" icon={<KeyRound />} type="submit">
                Issue developer key
              </Button>
            </div>
          </form>
          <details className="setup-disclosure flow-card" open={!data.users.length}>
            <summary>
              <UserPlus />
              <span>Create developer</span>
            </summary>
            <form className="form-grid" onSubmit={createUser}>
              <div className="flow-heading full">
                <span>Use this only when the developer does not already exist.</span>
              </div>
              <Field label="Email" name="email" required placeholder="dev@example.com" />
              <Field label="Name" name="name" required placeholder="Dev Example" />
              <Field label="Team Slug" name="teamSlug" placeholder="engineering" />
              <Field label="Team Name" name="teamName" placeholder="Engineering" />
              <div className="actions full">
                <Button tone="secondary" icon={<UserPlus />} type="submit">
                  Create developer
                </Button>
              </div>
            </form>
          </details>
        </div>
      </Panel>
      <Panel className={`stack ${newKey ? 'muted-panel' : ''}`}>
        <TableToolbar
          title="Developer Keys"
          hint="Revoke a key only when it leaks or a developer loses access."
          filters={filters}
          setFilters={setFilters}
          options={['active', 'revoked']}
        />
        <DataTable
          empty="No developer keys yet. Select a developer and issue the first key."
          sort={sort}
          setSort={setSort}
          columns={[
            {
              key: 'name',
              label: 'Developer key',
              render: (key: ApiKey) => (
                <>
                  <strong>{key.name}</strong>
                  <div className="hint">Developer key</div>
                </>
              ),
            },
            {
              key: 'userId',
              label: 'Developer',
              render: (key: ApiKey) => {
                const user = key.user || data.users.find((item) => item.id === key.userId);
                return (
                  <>
                    <strong>{user?.email || 'Unknown developer'}</strong>
                    {user?.name && <div className="hint">{user.name}</div>}
                  </>
                );
              },
            },
            {
              key: 'teamId',
              label: 'Team',
              render: (key: ApiKey) => (
                <>
                  <strong>{key.team?.name || key.team?.slug || 'No team'}</strong>
                  {key.team?.slug && key.team.name !== key.team.slug && (
                    <div className="hint">{key.team.slug}</div>
                  )}
                </>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              render: (key: ApiKey) =>
                pendingAction?.kind === 'key-revoke' && pendingAction.id === key.id ? (
                  <PendingBadge>Revoking...</PendingBadge>
                ) : (
                  <Badge tone={key.status === 'active' ? 'ok' : 'off'}>
                    {titleCase(key.status)}
                  </Badge>
                ),
            },
            {
              key: 'createdAt',
              label: 'Created',
              render: (key: ApiKey) => <RelativeTime value={key.createdAt} />,
            },
            {
              key: 'lastUsedAt',
              label: 'Last used',
              render: (key: ApiKey) => <RelativeTime value={key.lastUsedAt} empty="Never" />,
            },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              render: (key: ApiKey) => (
                <ActionMenu
                  label="Key actions"
                  items={[
                    {
                      label: 'View details',
                      onClick: () =>
                        setModal({
                          kind: 'details',
                          title: `Developer key: ${key.name}`,
                          body: <RecordDetails rows={objectRows(key)} />,
                        }),
                    },
                    ...(key.status === 'active'
                      ? [
                          {
                            label: 'Revoke key',
                            danger: true,
                            onClick: () =>
                              setModal({
                                kind: 'danger',
                                title: 'Revoke developer key',
                                label: 'Revoke key',
                                confirmText: key.prefix,
                                success: `Developer key revoked: ${key.prefix}.`,
                                pending: { kind: 'key-revoke', id: key.id },
                                body: (
                                  <>
                                    This revokes key <code>{key.prefix}</code>. Existing clients
                                    using this key will fail immediately. Revocation cannot reveal
                                    the old key again. To recover, issue a new developer key.
                                  </>
                                ),
                                action: () => api.revokeKey(token, key.id).then(() => undefined),
                              }),
                          },
                        ]
                      : []),
                  ]}
                />
              ),
            },
          ]}
          rows={rows}
          hasMore={Boolean(nextCursor)}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
        />
      </Panel>
    </>
  );
}

function Providers({
  data,
  errors,
  token,
  run,
  setModal,
  pendingAction,
  onRetry,
}: {
  data: DashboardData;
  errors: Partial<Record<SectionKey, string>>;
  token: string;
  run: (
    action: () => Promise<void>,
    success: string,
    tone?: Tone,
    pending?: PendingAction,
  ) => Promise<void>;
  setModal: (modal: ModalState) => void;
  pendingAction: PendingAction | null;
  onRetry: () => void;
}) {
  const [filters, setFilters] = useState({ q: '', status: 'all' });
  const [sort, setSort] = useState<SortState>({ key: 'slug', dir: 'asc' });
  const [providers, setProviders] = useState(data.providers);
  const [nextCursor, setNextCursor] = useState<string | null>(data.nextCursors.providers ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setProviders(data.providers);
    setNextCursor(data.nextCursors.providers ?? null);
  }, [data.providers, data.nextCursors.providers]);
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.getProviders(token, nextCursor);
      setProviders((items) => [...items, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  };
  const rows = useRows(providers, filters, sort, ['slug', 'name', 'baseUrl', 'healthStatus']);

  const createProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const slug = String(form.get('slug') || '').trim();
    const name = String(form.get('name') || '').trim();
    const baseUrl = String(form.get('baseUrl') || '').trim();
    const apiKey = String(form.get('apiKey') || '').trim();
    if (!slug || !name || !baseUrl) return;
    await run(
      () =>
        api
          .createProvider(token, { slug, name, baseUrl, apiKey: apiKey || undefined })
          .then(() => undefined),
      `Provider created: ${slug}. Run Check health next.`,
    );
    event.currentTarget.reset();
  };

  return (
    <>
      <SectionErrors errors={errors} sections={['providers', 'aliases']} onRetry={onRetry} />
      <details className="setup-disclosure panel" open={!data.providers.length}>
        <summary>
          <Server />
          <span>Add provider</span>
        </summary>
        <p className="sub">
          Use an OpenAI-compatible /v1 endpoint. Provider secrets are encrypted at rest.
        </p>
        <form className="form-grid" onSubmit={createProvider}>
          <Field label="Slug" name="slug" required placeholder="9router" />
          <Field label="Name" name="name" required placeholder="9Router Local" />
          <Field
            label="Base URL"
            name="baseUrl"
            required
            placeholder="http://9router:20128/v1"
            full
          />
          <Field
            label="API Key"
            name="apiKey"
            type="password"
            placeholder="provider token if required"
            full
          />
          <div className="actions full">
            <Button tone="primary" icon={<Server />} type="submit">
              Create Provider
            </Button>
          </div>
        </form>
        <div className="notice stack">
          Use API credentials, local 9Router, or local model servers. Do not use browser sessions or
          shared personal subscriptions as provider credentials.
        </div>
      </details>
      <Panel className="stack">
        <TableToolbar
          title="Providers"
          hint="Health checks and rotations are operator actions."
          filters={filters}
          setFilters={setFilters}
          options={['enabled', 'disabled', 'healthy', 'unhealthy', 'unchecked']}
        />
        <DataTable
          empty="No providers configured. Add 9Router, ai.example.com, or another OpenAI-compatible upstream."
          sort={sort}
          setSort={setSort}
          columns={[
            {
              key: 'slug',
              label: 'Provider',
              render: (p: Provider) => (
                <>
                  <strong>{p.slug}</strong>
                  <div className="hint">{p.name}</div>
                </>
              ),
            },
            { key: 'baseUrl', label: 'Endpoint', className: 'mono truncate' },
            {
              key: 'enabled',
              label: 'Enabled',
              render: (p: Provider) => (
                <Badge tone={p.enabled ? 'ok' : 'off'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
              ),
            },
            {
              key: 'apiKeyLast4',
              label: 'Key',
              render: (p: Provider) => (p.apiKeyLast4 ? `Ending in ${p.apiKeyLast4}` : 'No key'),
            },
            {
              key: 'healthStatus',
              label: 'Health',
              render: (p: Provider) =>
                pendingAction?.kind === 'provider-health' && pendingAction.id === p.id ? (
                  <PendingBadge>Checking...</PendingBadge>
                ) : pendingAction?.kind === 'provider-rotate' && pendingAction.id === p.id ? (
                  <PendingBadge>Rotating key...</PendingBadge>
                ) : pendingAction?.kind === 'provider-disable' && pendingAction.id === p.id ? (
                  <PendingBadge>Disabling...</PendingBadge>
                ) : (
                  providerBadge(p)
                ),
            },
            {
              key: 'lastHealthAt',
              label: 'Last health check',
              render: (p: Provider) => <RelativeTime value={p.lastHealthAt} empty="Never" />,
            },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              render: (p: Provider) => (
                <div className="row tight">
                  <Button
                    loading={pendingAction?.kind === 'provider-health' && pendingAction.id === p.id}
                    onClick={() =>
                      run(
                        () => api.checkProvider(token, p.id).then(() => undefined),
                        `Provider health checked: ${p.slug}.`,
                        'ok',
                        { kind: 'provider-health', id: p.id },
                      )
                    }
                  >
                    Check health
                  </Button>
                  <ActionMenu
                    label="Provider actions"
                    items={[
                      {
                        label: 'View details',
                        onClick: () =>
                          setModal({
                            kind: 'details',
                            title: `Provider: ${p.slug}`,
                            body: (
                              <RecordDetails
                                rows={[
                                  ...objectRows(p),
                                  [
                                    'Affected aliases',
                                    affectedAliases(data.aliases, p.id).toString(),
                                  ],
                                ]}
                              />
                            ),
                          }),
                      },
                      {
                        label: 'Rotate key',
                        onClick: () =>
                          setModal({
                            kind: 'rotate',
                            provider: p,
                            affectedAliases: affectedAliases(data.aliases, p.id),
                          }),
                      },
                      {
                        label: 'Disable provider',
                        danger: true,
                        onClick: () =>
                          setModal({
                            kind: 'danger',
                            title: 'Disable provider',
                            label: 'Disable provider',
                            confirmText: p.slug,
                            success: `Provider disabled: ${p.slug}. ${affectedAliases(
                              data.aliases,
                              p.id,
                            )} aliases were disabled.`,
                            pending: { kind: 'provider-disable', id: p.id },
                            body: (
                              <>
                                This disables provider <strong>{p.slug}</strong> and{' '}
                                <strong>{affectedAliases(data.aliases, p.id)}</strong> enabled
                                aliases that route through it. Traffic using those aliases may fail
                                immediately. Historical usage data is preserved. To recover,
                                re-enable or recreate the provider, then sync affected aliases.
                              </>
                            ),
                            action: () => api.disableProvider(token, p.id).then(() => undefined),
                          }),
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={rows}
          hasMore={Boolean(nextCursor)}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
        />
      </Panel>
    </>
  );
}

function Aliases({
  data,
  errors,
  token,
  run,
  setModal,
  pendingAction,
  onRetry,
}: {
  data: DashboardData;
  errors: Partial<Record<SectionKey, string>>;
  token: string;
  run: (
    action: () => Promise<void>,
    success: string,
    tone?: Tone,
    pending?: PendingAction,
  ) => Promise<void>;
  setModal: (modal: ModalState) => void;
  pendingAction: PendingAction | null;
  onRetry: () => void;
}) {
  const [filters, setFilters] = useState({ q: '', status: 'all' });
  const [sort, setSort] = useState<SortState>({ key: 'alias', dir: 'asc' });
  const [aliases, setAliases] = useState(data.aliases);
  const [nextCursor, setNextCursor] = useState<string | null>(data.nextCursors.aliases ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setAliases(data.aliases);
    setNextCursor(data.nextCursors.aliases ?? null);
  }, [data.aliases, data.nextCursors.aliases]);
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.getAliases(token, nextCursor);
      setAliases((items) => [...items, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  };
  const rows = useRows(aliases, filters, sort, [
    'alias',
    'upstreamModel',
    (alias) => alias.provider?.slug,
  ]);

  const createAlias = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const alias = String(form.get('alias') || '').trim();
    const providerId = String(form.get('providerId') || '');
    const upstreamModel = String(form.get('upstreamModel') || '').trim();
    if (!alias || !providerId || !upstreamModel) return;
    await run(
      () => api.createAlias(token, { alias, providerId, upstreamModel }).then(() => undefined),
      `Alias created and sync requested: ${alias}.`,
    );
  };

  return (
    <>
      <SectionErrors errors={errors} sections={['aliases', 'providers']} onRetry={onRetry} />
      <details className="setup-disclosure panel" open={!data.aliases.length}>
        <summary>
          <Route />
          <span>Create model alias</span>
        </summary>
        <p className="sub">
          Aliases are stable public names developers use from Codex, Cursor, Cline, and automation.
        </p>
        <form className="form-grid" onSubmit={createAlias}>
          <Field label="Alias" name="alias" required defaultValue="code-premium" />
          <div className="field">
            <span>Provider *</span>
            <SearchableSelect
              name="providerId"
              placeholder={data.providers.length ? 'Select provider' : 'Create a provider first'}
              options={data.providers
                .filter((provider) => provider.enabled)
                .map((provider) => ({
                  value: provider.id,
                  label: provider.slug,
                  description: provider.name,
                }))}
            />
          </div>
          <Field
            label="Upstream Model"
            name="upstreamModel"
            required
            defaultValue="openai/gemini-2.5-pro"
            full
          />
          <div className="actions full">
            <Button tone="primary" icon={<Route />} type="submit">
              Create and sync alias
            </Button>
          </div>
        </form>
        <div className="notice stack">
          <code>
            Codex -&gt; LiteLLM key -&gt; code-premium -&gt; provider -&gt; upstream model
          </code>
        </div>
      </details>
      <Panel className="stack">
        <TableToolbar
          title="Model Aliases"
          hint="Sync after changing provider credentials or upstream model IDs."
          filters={filters}
          setFilters={setFilters}
          options={['enabled', 'disabled']}
        />
        <DataTable
          empty="No model aliases yet. Create stable names like code-premium before sending traffic."
          sort={sort}
          setSort={setSort}
          columns={[
            { key: 'alias', label: 'Alias', className: 'mono strong' },
            {
              key: 'provider',
              label: 'Provider',
              render: (a: ModelAlias) => a.provider?.slug || 'unknown',
            },
            { key: 'upstreamModel', label: 'Upstream model', className: 'mono truncate' },
            {
              key: 'enabled',
              label: 'Enabled',
              render: (a: ModelAlias) =>
                pendingAction?.kind === 'alias-sync' && pendingAction.id === a.id ? (
                  <PendingBadge>Syncing...</PendingBadge>
                ) : pendingAction?.kind === 'alias-disable' && pendingAction.id === a.id ? (
                  <PendingBadge>Disabling...</PendingBadge>
                ) : (
                  <Badge tone={a.enabled ? 'ok' : 'off'}>
                    {a.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                ),
            },
            {
              key: 'lastSyncedAt',
              label: 'Last synced',
              render: (a: ModelAlias) => <RelativeTime value={a.lastSyncedAt} empty="Never" />,
            },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              render: (a: ModelAlias) => (
                <div className="row tight">
                  <Button
                    loading={pendingAction?.kind === 'alias-sync' && pendingAction.id === a.id}
                    onClick={() =>
                      run(
                        () => api.syncAlias(token, a.id).then(() => undefined),
                        `Alias synced: ${a.alias}.`,
                        'ok',
                        { kind: 'alias-sync', id: a.id },
                      )
                    }
                  >
                    Sync alias
                  </Button>
                  <ActionMenu
                    label="Alias actions"
                    items={[
                      {
                        label: 'View details',
                        onClick: () =>
                          setModal({
                            kind: 'details',
                            title: `Alias: ${a.alias}`,
                            body: <RecordDetails rows={objectRows(a)} />,
                          }),
                      },
                      {
                        label: 'Disable alias',
                        danger: true,
                        onClick: () =>
                          setModal({
                            kind: 'danger',
                            title: 'Disable alias',
                            label: 'Disable alias',
                            confirmText: a.alias,
                            success: `Alias disabled: ${a.alias}.`,
                            pending: { kind: 'alias-disable', id: a.id },
                            body: (
                              <>
                                This disables alias <code>{a.alias}</code>. Clients using this model
                                name may fail immediately until they switch routes or the alias is
                                restored. To recover, recreate or re-enable the alias and sync it.
                              </>
                            ),
                            action: () => api.disableAlias(token, a.id).then(() => undefined),
                          }),
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={rows}
          hasMore={Boolean(nextCursor)}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
        />
      </Panel>
    </>
  );
}

function Usage({
  data,
  errors,
  token,
  notify,
  pendingAction,
  setPendingAction,
  onRetry,
}: {
  data: DashboardData;
  errors: Partial<Record<SectionKey, string>>;
  token: string;
  notify: (message: string, tone?: Tone) => void;
  pendingAction: PendingAction | null;
  setPendingAction: (pending: PendingAction | null) => void;
  onRetry: () => void;
}) {
  const [usage, setUsage] = useState<UsageResponse | null>(data.usage);
  const [source, setSource] = useState<'litellm' | 'local'>('litellm');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState('allTime');
  const [metric, setMetric] = useState<UsageMetric>('estimatedCost');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<UsageTab>('users');
  useEffect(() => setUsage(data.usage), [data.usage]);
  const rankedUsers = rankUsageRows(usage?.byUser || [], metric);
  const rankedTeams = rankUsageRows(usage?.byTeam || [], metric);
  const rankedModels = rankUsageRows(usage?.byModel || [], metric);
  const rankedKeys = rankUsageRows(usage?.byKey || [], metric);
  const selectedUser =
    (usage?.byUser || []).find((row) => usageUserId(row) === selectedUserId) || null;
  const unknownRequests = usage?.unknownAttribution?.requests || 0;
  const rangeLabel = usagePresetLabel(preset);
  const metricLabel = usageMetricLabel(metric);

  const applyPreset = (value: string) => {
    setPreset(value);
    if (value === 'custom') return;
    const range = usagePresetRange(value);
    setFrom(range.from);
    setTo(range.to);
  };

  const refreshUsage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token.trim()) return notify('Enter the admin token before loading usage.', 'warn');
    setLoading(true);
    setPendingAction({ kind: 'usage-refresh' });
    try {
      setUsage(await api.getUsage(token, { source, from: from || undefined, to: to || undefined }));
      notify(
        `Usage refreshed from ${source === 'litellm' ? 'LiteLLM spend logs' : 'local ingest records'}.`,
      );
    } catch (error) {
      notify(
        `Usage refresh failed. Check ${
          source === 'litellm' ? 'LiteLLM spend logs' : 'local ingest records'
        } and retry. ${error instanceof Error ? error.message : ''}`,
        'danger',
      );
    } finally {
      setLoading(false);
      setPendingAction(null);
    }
  };

  return (
    <>
      <SectionErrors errors={errors} sections={['usage']} onRetry={onRetry} />
      <div className="grid three">
        <Metric label="Requests" value={usage?.totals.requests || 0} />
        <Metric label="Total tokens" value={usage?.totals.totalTokens || 0} />
        <Metric
          label="Estimated cost"
          value={`$${Number(usage?.totals.estimatedCost || 0).toFixed(4)}`}
        />
      </div>
      <Panel
        className="stack"
        title="Usage Snapshot"
        subtitle={`Source: ${usage?.source || 'LiteLLM spend logs'}`}
      >
        <form onSubmit={refreshUsage}>
          <div className="toolbar-row">
            <div>
              <UsageStatus usage={usage} source={source} from={from} to={to} />
              {unknownRequests > 0 && (
                <div className="notice warn">
                  {unknownRequests} unattributed request{unknownRequests === 1 ? '' : 's'} · Review
                  attribution
                </div>
              )}
            </div>
            <div className="actions usage-actions">
              <UsageExportMenu usage={usage} />
              {pendingAction?.kind === 'usage-refresh' && (
                <PendingBadge>Refreshing...</PendingBadge>
              )}
              <Button
                type="submit"
                icon={<RefreshCw />}
                disabled={loading}
                loading={pendingAction?.kind === 'usage-refresh'}
              >
                {loading ? 'Refreshing usage' : 'Refresh usage'}
              </Button>
            </div>
          </div>
          <div className="leaderboard-controls">
            <div className="field">
              <span>Range</span>
              <SearchableSelect
                value={preset}
                onChange={applyPreset}
                options={[
                  { value: 'allTime', label: 'All time' },
                  { value: 'thisWeek', label: 'This week' },
                  { value: 'thisMonth', label: 'This month' },
                  { value: 'lastMonth', label: 'Last month' },
                  { value: 'last7', label: 'Last 7 days' },
                  { value: 'today', label: 'Today' },
                  { value: 'custom', label: 'Custom range' },
                ]}
              />
            </div>
            <div className="field">
              <span>Rank by</span>
              <SearchableSelect
                value={metric}
                onChange={(value) => setMetric(value as UsageMetric)}
                options={[
                  { value: 'estimatedCost', label: 'Cost' },
                  { value: 'totalTokens', label: 'Tokens' },
                  { value: 'requests', label: 'Requests' },
                  { value: 'errors', label: 'Errors' },
                ]}
              />
            </div>
            <div className="field">
              <span>Source</span>
              <SearchableSelect
                value={source}
                onChange={(value) => setSource(value as 'litellm' | 'local')}
                options={[
                  { value: 'litellm', label: 'LiteLLM spend logs' },
                  { value: 'local', label: 'Local ingest records' },
                ]}
              />
            </div>
            {preset === 'custom' && (
              <>
                <label className="field">
                  <span>From</span>
                  <input
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>To</span>
                  <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                </label>
              </>
            )}
          </div>
        </form>
        <Tabs
          active={activeTab}
          onChange={setActiveTab}
          items={[
            { id: 'users', label: 'Users' },
            { id: 'teams', label: 'Teams' },
            { id: 'models', label: 'Models' },
            { id: 'keys', label: 'Keys' },
            { id: 'attribution', label: 'Attribution' },
          ]}
        />
        {activeTab === 'users' && (
          <UserUsageTable
            title={`User leaderboard · ${rangeLabel} · ${metricLabel}`}
            rows={rankedUsers}
            defaultSortKey={metric}
            onSelect={(row) => setSelectedUserId(usageUserId(row))}
          />
        )}
        {activeTab === 'teams' && (
          <UsageTable
            title={`Team leaderboard · ${rangeLabel} · ${metricLabel}`}
            rows={rankedTeams}
            rowKey="team"
            defaultSortKey={metric}
          />
        )}
        {activeTab === 'models' && (
          <UsageTable
            title={`Model leaderboard · ${rangeLabel} · ${metricLabel}`}
            rows={rankedModels}
            rowKey="model"
            defaultSortKey={metric}
          />
        )}
        {activeTab === 'keys' && (
          <UsageTable
            title={`Key leaderboard · ${rangeLabel} · ${metricLabel}`}
            rows={rankedKeys}
            rowKey="key"
            defaultSortKey={metric}
          />
        )}
        {activeTab === 'attribution' && (
          <AttributionPanel usage={usage} unknownRequests={unknownRequests} />
        )}
        {selectedUser && (
          <UserUsageDetail row={selectedUser} onClose={() => setSelectedUserId(null)} />
        )}
      </Panel>
    </>
  );
}

function ActivityLogs({
  token,
  notify,
  data,
}: {
  token: string;
  notify: (message: string, tone?: Tone) => void;
  data: DashboardData;
}) {
  const [status, setStatus] = useState<ActivityLogStatus | null>(null);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [rows, setRows] = useState<ActivityLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<ActivityLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', dir: 'desc' });
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    userId: '',
    projectId: '',
    model: '',
    keyAlias: '',
    status: '',
    clientName: '',
  });
  const sorted = useMemo(
    () => sortRows(rows as unknown as Record<string, unknown>[], sort),
    [rows, sort],
  ) as unknown as ActivityLog[];

  const query = () => ({
    ...filters,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(filters.to).toISOString() : undefined,
    limit: '50',
  });

  const refreshActivity = async () => {
    if (!token.trim()) return notify('Enter the admin token before loading activity logs.', 'warn');
    setLoading(true);
    try {
      const [nextStatus, nextSummary, nextRows, nextProjects] = await Promise.all([
        api.getActivityStatus(token),
        api.getActivitySummary(token, query()),
        api.getActivityLogs(token, query()),
        api.getProjects(token),
      ]);
      setStatus(nextStatus);
      setSummary(nextSummary);
      setRows(nextRows.items);
      setNextCursor(nextRows.nextCursor ?? null);
      setProjects(nextProjects.items.map((project) => ({ id: project.id, name: project.name })));
    } catch (error) {
      notify(
        `Activity logs failed to load. ${error instanceof Error ? error.message : ''}`,
        'danger',
      );
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.getActivityLogs(token, { ...query(), cursor: nextCursor });
      setRows((items) => [...items, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } catch (error) {
      notify(
        `More activity logs failed to load. ${error instanceof Error ? error.message : ''}`,
        'danger',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    refreshActivity();
  }, []);

  const openDetail = async (row: ActivityLog) => {
    setDetailLoading(true);
    try {
      setSelected(await api.getActivityLog(token, row.id));
    } catch (error) {
      notify(
        `Activity detail failed to load. ${error instanceof Error ? error.message : ''}`,
        'danger',
      );
    } finally {
      setDetailLoading(false);
    }
  };

  const cleanup = async () => {
    try {
      const result = await api.cleanupActivityLogs(token);
      notify(`Deleted ${result.deleted} expired activity log${result.deleted === 1 ? '' : 's'}.`);
      await refreshActivity();
    } catch (error) {
      notify(`Cleanup failed. ${error instanceof Error ? error.message : ''}`, 'danger');
    }
  };

  return (
    <div className="stack">
      <Panel
        title="Activity Status"
        subtitle="Prompt content is stored only when explicitly enabled by environment."
      >
        <div className="grid five">
          <Metric
            label="Logging"
            value={status?.enabled ? 'Enabled' : 'Disabled'}
            badge={
              <Badge tone={status?.enabled ? 'ok' : 'off'}>{status?.level || 'metadata'}</Badge>
            }
          />
          <Metric label="Retention" value={`${status?.retentionDays ?? 7} days`} />
          <Metric
            label="Redaction"
            value={status?.redactionEnabled === false ? 'Off' : 'On'}
            badge={<Badge tone={status?.redactionEnabled === false ? 'warn' : 'ok'}>Default</Badge>}
          />
          <Metric
            label="Completions"
            value={status?.storeCompletions ? 'Stored' : 'Off'}
            badge={<Badge tone={status?.storeCompletions ? 'warn' : 'ok'}>Content</Badge>}
          />
          <Metric label="Cleanup" value={status?.cleanupEnabled === false ? 'Off' : 'On'} />
        </div>
        {!status?.enabled && (
          <div className="notice warn">
            Prompt logging is disabled. Activity can still show usage metadata from LiteLLM spend
            logs when available.
          </div>
        )}
      </Panel>

      <div className="grid six">
        <Metric label="Requests" value={summary?.requests || 0} />
        <Metric label="Active users" value={summary?.activeUsers || 0} />
        <Metric label="Active projects" value={summary?.activeProjects || 0} />
        <Metric label="Tokens" value={summary?.tokens || 0} />
        <Metric label="Estimated cost" value={formatMoney(summary?.estimatedCost || 0)} />
        <Metric
          label="Suspicious/errors"
          value={summary?.suspiciousOrErrorRequests || 0}
          badge={
            <Badge tone={summary?.suspiciousOrErrorRequests ? 'warn' : 'ok'}>
              {summary?.suspiciousOrErrorRequests ? 'Review' : 'Clear'}
            </Badge>
          }
        />
      </div>

      <Panel
        className="stack"
        title="Activity Logs"
        subtitle="Filter by user, project, model, key, status, and client."
      >
        <div className="leaderboard-controls">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </label>
          <label className="field">
            <span>User</span>
            <SearchableSelect
              value={filters.userId}
              onChange={(value) => setFilters({ ...filters, userId: value })}
              options={[
                { value: '', label: 'All users' },
                ...data.users.map((user) => ({ value: user.id, label: user.name || user.email })),
              ]}
            />
          </label>
          <label className="field">
            <span>Project</span>
            <SearchableSelect
              value={filters.projectId}
              onChange={(value) => setFilters({ ...filters, projectId: value })}
              options={[
                { value: '', label: 'All projects' },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <SearchableSelect
              value={filters.status}
              onChange={(value) => setFilters({ ...filters, status: value })}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
                { value: 'rate_limited', label: 'Rate limited' },
                { value: 'budget_exceeded', label: 'Budget exceeded' },
              ]}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              value={filters.model}
              onChange={(event) => setFilters({ ...filters, model: event.target.value })}
              placeholder="code-premium"
            />
          </label>
          <label className="field">
            <span>Key</span>
            <input
              value={filters.keyAlias}
              onChange={(event) => setFilters({ ...filters, keyAlias: event.target.value })}
              placeholder="tlg_..."
            />
          </label>
          <label className="field">
            <span>Client</span>
            <input
              value={filters.clientName}
              onChange={(event) => setFilters({ ...filters, clientName: event.target.value })}
              placeholder="codex"
            />
          </label>
        </div>
        <div className="actions">
          <Button
            icon={<RefreshCw />}
            onClick={refreshActivity}
            loading={loading}
            disabled={loading}
          >
            {loading ? 'Loading activity' : 'Refresh activity'}
          </Button>
          <Button tone="utility" icon={<AlertTriangle />} onClick={cleanup}>
            Cleanup expired
          </Button>
          {detailLoading && <PendingBadge>Opening detail...</PendingBadge>}
        </div>
        <DataTable
          empty={
            status?.enabled === false
              ? 'Activity metadata is not available yet. Enable or ingest activity logging first.'
              : 'No activity logs match the current filters.'
          }
          rows={sorted as unknown as Record<string, unknown>[]}
          hasMore={Boolean(nextCursor)}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
          sort={sort}
          setSort={setSort}
          columns={[
            {
              key: 'createdAt',
              label: 'Time',
              render: (row) => <RelativeTime value={row.createdAt as string} />,
            },
            {
              key: 'user',
              label: 'User',
              render: (row) => activityUser(row as unknown as ActivityLog),
            },
            {
              key: 'projectName',
              label: 'Project',
              render: (row) => String((row as unknown as ActivityLog).projectName || 'Unassigned'),
            },
            {
              key: 'clientName',
              label: 'Client',
              render: (row) => activityClient(row as unknown as ActivityLog),
            },
            { key: 'model', label: 'Model', className: 'mono' },
            {
              key: 'status',
              label: 'Status',
              render: (row) => (
                <Badge tone={activityStatusTone(String(row.status))}>
                  {titleCase(String(row.status))}
                </Badge>
              ),
            },
            { key: 'totalTokens', label: 'Tokens' },
            {
              key: 'estimatedCost',
              label: 'Cost',
              render: (row) => formatMoney(row.estimatedCost),
            },
            {
              key: 'promptPreview',
              label: 'Prompt preview',
              sortable: false,
              render: (row) => (
                <span className="truncate">{String(row.promptPreview || 'No prompt content')}</span>
              ),
            },
            {
              key: 'action',
              label: 'Action',
              sortable: false,
              render: (row) => (
                <Button tone="utility" onClick={() => openDetail(row as unknown as ActivityLog)}>
                  Inspect
                </Button>
              ),
            },
          ]}
        />
      </Panel>

      {selected && <ActivityDetail log={selected} close={() => setSelected(null)} />}
    </div>
  );
}

function ActivityDetail({ log, close }: { log: ActivityLog; close: () => void }) {
  return (
    <Panel
      className="stack detail-drawer"
      title={`Activity detail: ${log.requestId || log.id}`}
      subtitle="Detail access is audited when enabled. Raw prompt content is omitted unless full logging is enabled."
    >
      <div className="actions">
        <Button tone="utility" onClick={close}>
          Close
        </Button>
      </div>
      <div className="grid three">
        <Metric label="Project" value={log.projectName || 'Unassigned'} />
        <Metric label="Tokens" value={log.totalTokens || 0} />
        <Metric label="Cost" value={formatMoney(log.estimatedCost)} />
      </div>
      <RecordDetails
        rows={[
          ['User', log.user?.email || log.userId || 'Unknown'],
          ['Team', log.team?.name || log.teamId || 'None'],
          ['Client', activityClient(log)],
          ['Model', log.model],
          ['Provider', log.provider],
          ['Status', log.status],
          ['Latency', log.latencyMs == null ? 'Unknown' : `${log.latencyMs} ms`],
          ['Source', log.source],
          ['Expires', formatDate(log.expiresAt)],
          ['Redaction applied', log.redactionApplied ? 'yes' : 'no'],
        ]}
      />
      <Panel title="Prompt Preview">
        <pre className="callout mono">
          {log.promptPreview || 'No prompt preview stored for this log.'}
        </pre>
      </Panel>
      <Panel title="Completion Preview">
        <pre className="callout mono">
          {log.completionPreview || 'No completion preview stored for this log.'}
        </pre>
      </Panel>
      <details className="raw-json">
        <summary>Full prompt</summary>
        <pre className="callout mono">
          {log.promptContent || 'Full prompt is not available for this logging level.'}
        </pre>
      </details>
      <details className="raw-json">
        <summary>Raw JSON</summary>
        <pre className="callout mono">{JSON.stringify(log.raw || {}, null, 2)}</pre>
      </details>
      <div className="notice">
        Viewing this detail may write an audit event. Audit metadata never includes raw prompt
        content.
      </div>
    </Panel>
  );
}

function SettingsView({
  token,
  clearSession,
  notify,
}: {
  token: string;
  clearSession: () => void;
  notify: (message: string, tone?: Tone) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [clientConfig, setClientConfig] = useState({
    openaiBaseUrl: 'http://localhost:4000/v1',
    defaultModel: 'code-premium',
  });
  const env = `OPENAI_BASE_URL=${clientConfig.openaiBaseUrl}\nOPENAI_API_KEY=<personal_litellm_key>\nOPENAI_MODEL=${clientConfig.defaultModel}`;

  useEffect(() => {
    let active = true;
    api
      .getClientConfig(token)
      .then((config) => {
        if (active) setClientConfig(config);
      })
      .catch((error) => {
        if (!active) return;
        notify(error instanceof Error ? error.message : 'Client config failed to load.', 'warn');
      });

    return () => {
      active = false;
    };
  }, [token]);

  return (
    <>
      <div className="grid two">
        <Panel title="Codex Configuration" subtitle="Give each developer their own developer key.">
          <pre className="callout info mono">{env}</pre>
          <div className="actions">
            <Button
              tone="utility"
              icon={<Copy />}
              onClick={() =>
                navigator.clipboard.writeText(env).then(() => notify('Codex config copied.'))
              }
            >
              Copy Codex config
            </Button>
          </div>
        </Panel>
        <Panel
          title="Security Baseline"
          subtitle="This dashboard is admin-only and should remain behind VPN or access control."
          quiet
        >
          <div className="notice">
            Keep admin access behind private network controls. Give developers personal keys instead
            of shared admin credentials.
          </div>
        </Panel>
      </div>
      <Panel className="stack danger-zone" title="Danger Zone" subtitle="Session-only controls.">
        <div className="danger-zone-grid">
          <div>
            <strong>Clear admin token</strong>
            <p className="hint">
              Removes the saved token and clears loaded dashboard data from this browser.
            </p>
          </div>
          <label className="field">
            <span>Type CLEAR to confirm</span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="CLEAR"
            />
          </label>
          <Button
            tone="danger"
            icon={<LogOut />}
            disabled={confirmation !== 'CLEAR'}
            onClick={() => {
              clearSession();
              setConfirmation('');
            }}
          >
            Clear token
          </Button>
        </div>
      </Panel>
    </>
  );
}

function Modal({
  modal,
  token,
  run,
  close,
}: {
  modal: ModalState;
  token: string;
  run: (
    action: () => Promise<void>,
    success: string,
    tone?: Tone,
    pending?: PendingAction,
  ) => Promise<void>;
  close: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [confirmation, setConfirmation] = useState('');
  if (!modal) return null;
  const submitRotate = async () => {
    if (modal.kind !== 'rotate' || !apiKey.trim()) return;
    await run(
      () => api.rotateProvider(token, modal.provider.id, apiKey.trim()).then(() => undefined),
      `Provider key rotated: ${modal.provider.slug}. ${modal.affectedAliases} aliases synced.`,
      'ok',
      { kind: 'provider-rotate', id: modal.provider.id },
    );
    close();
  };
  const submitDanger = async () => {
    if (modal.kind !== 'danger' || confirmation !== modal.confirmText) return;
    await run(modal.action, modal.success, 'warn', modal.pending);
    close();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => event.currentTarget === event.target && close()}
    >
      <div className="modal">
        <h3>{modal.kind === 'rotate' ? 'Rotate provider key' : modal.title}</h3>
        <div className="modal-body">
          {modal.kind === 'details' ? (
            modal.body
          ) : modal.kind === 'rotate' ? (
            <>
              <p>
                This replaces the stored credential for <strong>{modal.provider.slug}</strong> and
                syncs <strong>{modal.affectedAliases}</strong> affected aliases. Existing traffic
                may fail if the new key is invalid. To recover, rotate back to a working key and run
                Check health.
              </p>
              <label className="field">
                <span>New provider API key *</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <>
              <p>{modal.body}</p>
              <label className="field">
                <span>
                  Type <code>{modal.confirmText}</code> to confirm
                </span>
                <input
                  autoFocus
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
            </>
          )}
        </div>
        <div className="modal-actions">
          <Button onClick={close}>Cancel</Button>
          {modal.kind === 'details' ? null : (
            <Button
              tone="danger"
              icon={<AlertTriangle />}
              onClick={modal.kind === 'rotate' ? submitRotate : submitDanger}
              disabled={modal.kind === 'danger' && confirmation !== modal.confirmText}
            >
              {modal.kind === 'rotate' ? 'Rotate key and sync aliases' : modal.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Tabs<T extends string>({
  active,
  onChange,
  items,
}: {
  active: T;
  onChange: (value: T) => void;
  items: Array<{ id: T; label: string }>;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function UsageExportMenu({ usage }: { usage: UsageResponse | null }) {
  return (
    <details className="export-menu">
      <summary>
        <Copy />
        Export
      </summary>
      <div className="action-menu-popover">
        <button
          type="button"
          onClick={() => exportUsageCsv('usage-by-user.csv', usage?.byUser || [])}
        >
          Users CSV
        </button>
        <button
          type="button"
          onClick={() => exportUsageCsv('usage-by-team.csv', usage?.byTeam || [])}
        >
          Teams CSV
        </button>
        <button
          type="button"
          onClick={() =>
            exportUsageCsv('usage-daily-rollup.csv', usage?.rawDailyRollup || usage?.byDay || [])
          }
        >
          Daily CSV
        </button>
      </div>
    </details>
  );
}

function AttributionPanel({
  usage,
  unknownRequests,
}: {
  usage: UsageResponse | null;
  unknownRequests: number;
}) {
  const neverUsed = usage?.inactive?.keysNeverUsed?.length || 0;
  const quietUsers = usage?.inactive?.usersWithNoUsage?.length || 0;
  return (
    <div className="grid three">
      <Metric
        label="Unattributed requests"
        value={unknownRequests}
        badge={
          <Badge tone={unknownRequests ? 'warn' : 'ok'}>
            {unknownRequests ? 'Review' : 'Clear'}
          </Badge>
        }
      />
      <Metric
        label="Keys never used"
        value={neverUsed}
        badge={<Badge tone={neverUsed ? 'info' : 'ok'}>{neverUsed ? 'Check' : 'Clear'}</Badge>}
      />
      <Metric
        label="Users with no usage"
        value={quietUsers}
        badge={<Badge tone={quietUsers ? 'info' : 'ok'}>{quietUsers ? 'Check' : 'Clear'}</Badge>}
      />
    </div>
  );
}

function UsageStatus({
  usage,
  source,
  from,
  to,
}: {
  usage: UsageResponse | null;
  source: 'litellm' | 'local';
  from: string;
  to: string;
}) {
  if (!usage) {
    return (
      <div className="notice warn">
        Usage is not loaded · Refresh usage to check spend logs and attribution.
      </div>
    );
  }
  if (!usage.totals.requests) {
    return (
      <div className="notice">
        No usage in selected range ·{' '}
        {source === 'litellm' ? 'LiteLLM spend logs' : 'Local ingest records'}
        {from || to ? ' Adjust the date range if this looks unexpected.' : ''}
      </div>
    );
  }
  return (
    <div className="notice">
      {usage.totals.requests} requests loaded ·{' '}
      {source === 'litellm' ? 'LiteLLM spend logs' : 'Local ingest records'}
    </div>
  );
}

function UserUsageTable({
  title,
  rows,
  defaultSortKey = 'estimatedCost',
  onSelect,
}: {
  title: string;
  rows: UsageGroup[];
  defaultSortKey?: UsageMetric;
  onSelect: (row: UsageGroup) => void;
}) {
  const [sort, setSort] = useState<SortState>({ key: defaultSortKey, dir: 'desc' });
  useEffect(() => setSort({ key: defaultSortKey, dir: 'desc' }), [defaultSortKey]);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  return (
    <div>
      <h3>{title}</h3>
      <DataTable
        empty="No attributed usage in this range."
        rows={sorted}
        sort={sort}
        setSort={setSort}
        columns={[
          {
            key: 'user',
            label: 'User',
            render: (row: UsageGroup) => (
              <button className="link-button" type="button" onClick={() => onSelect(row)}>
                <span className="strong">{usageUserLabel(row)}</span>
                <span className="hint block">{row.team?.name || row.team?.slug || 'No team'}</span>
              </button>
            ),
          },
          { key: 'requests', label: 'Requests' },
          { key: 'totalTokens', label: 'Tokens' },
          {
            key: 'estimatedCost',
            label: 'Cost',
            render: (row: UsageGroup) => formatMoney(row.estimatedCost),
          },
          {
            key: 'lastUsage',
            label: 'Last activity',
            render: (row: UsageGroup) => <RelativeTime value={row.lastUsage} empty="Never" />,
          },
        ]}
      />
    </div>
  );
}

function UserUsageDetail({ row, onClose }: { row: UsageGroup; onClose: () => void }) {
  const costLimit = Number(row.budget?.monthlyCostLimit || 0);
  const tokenLimit = Number(row.budget?.monthlyTokenLimit || 0);
  const costPercent = costLimit
    ? Math.round((Number(row.estimatedCost || 0) / costLimit) * 100)
    : 0;
  const tokenPercent = tokenLimit
    ? Math.round((Number(row.totalTokens || 0) / tokenLimit) * 100)
    : 0;
  return (
    <Panel
      className="stack"
      title={`Usage detail: ${usageUserLabel(row)}`}
      subtitle="Requests, cost, models, keys, activity, and budget risk for the selected range."
    >
      <div className="actions">
        <Button type="button" tone="utility" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="grid four">
        <Metric label="Requests" value={row.requests || 0} />
        <Metric label="Total tokens" value={row.totalTokens || 0} />
        <Metric label="Estimated cost" value={formatMoney(row.estimatedCost)} />
        <Metric
          label="Errors"
          value={row.errors || 0}
          badge={row.errors ? <Badge tone="warn">Review</Badge> : <Badge tone="ok">Clear</Badge>}
        />
      </div>
      <div className="grid two">
        <Panel title="Budget status" subtitle="Warning starts at 80%; hard stop target is 100%.">
          {row.budget ? (
            <div className="stack small">
              <div className="row spread">
                <span>Cost budget</span>
                <Badge tone={costPercent >= 100 ? 'danger' : costPercent >= 80 ? 'warn' : 'ok'}>
                  {costPercent || 0}%
                </Badge>
              </div>
              <div className="hint">
                {formatMoney(row.estimatedCost)} of {formatMoney(row.budget.monthlyCostLimit || 0)}
              </div>
              <div className="row spread">
                <span>Token budget</span>
                <Badge tone={tokenPercent >= 100 ? 'danger' : tokenPercent >= 80 ? 'warn' : 'ok'}>
                  {tokenPercent || 0}%
                </Badge>
              </div>
              <div className="hint">
                {row.totalTokens || 0} of {row.budget.monthlyTokenLimit || 0} tokens
              </div>
            </div>
          ) : (
            <div className="empty">
              No active user budget. Set a budget to make this operational.
            </div>
          )}
        </Panel>
        <Panel title="Anomalies" subtitle="Simple rule-based signals for operational review.">
          {row.anomalies?.length ? (
            <ul className="compact-list">
              {row.anomalies.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <div className="empty">No anomaly detected in this range.</div>
          )}
        </Panel>
      </div>
      <div className="grid two">
        <UsageTable title="Cost by model" rows={row.modelBreakdown || []} rowKey="name" />
        <UsageTable title="Cost by developer key" rows={row.keyBreakdown || []} rowKey="name" />
      </div>
      <UsageTable title="Daily trend" rows={row.daily || []} rowKey="date" />
    </Panel>
  );
}

function UsageTable({
  title,
  rows,
  rowKey,
  defaultSortKey = 'requests',
}: {
  title: string;
  rows: UsageGroup[];
  rowKey: string;
  defaultSortKey?: UsageMetric | 'requests';
}) {
  const [sort, setSort] = useState<SortState>({ key: defaultSortKey, dir: 'desc' });
  useEffect(() => setSort({ key: defaultSortKey, dir: 'desc' }), [defaultSortKey]);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  return (
    <div>
      <h3>{title}</h3>
      <DataTable
        empty="No usage recorded yet."
        rows={sorted}
        sort={sort}
        setSort={setSort}
        columns={[
          {
            key: rowKey,
            label: rowKey,
            className: 'mono',
            render: (row: UsageGroup) => usageGroupLabel(row, rowKey),
          },
          { key: 'requests', label: 'Requests' },
          { key: 'totalTokens', label: 'Tokens' },
          {
            key: 'estimatedCost',
            label: 'Cost',
            render: (row: UsageGroup) => formatMoney(row.estimatedCost),
          },
        ]}
      />
    </div>
  );
}

function SearchableSelect({
  name,
  value,
  defaultValue = '',
  onChange,
  options,
  placeholder = 'Select option',
  className = '',
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
  className?: string;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue);
  const filtered = options.filter((option) =>
    `${option.label} ${option.description || ''} ${option.value}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const choose = (nextValue: string) => {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className={`searchable-select ${className}`} ref={rootRef}>
      {name && <input type="hidden" name={name} value={selectedValue} />}
      <button
        type="button"
        className="searchable-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
      >
        <span>
          {selected?.label || placeholder}
          {selected?.description && <small>{selected.description}</small>}
        </span>
      </button>
      {open && (
        <div className="searchable-select-popover">
          <label className="search compact">
            <Search />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search..."
            />
          </label>
          <div className="searchable-select-list" role="listbox">
            {filtered.length ? (
              filtered.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  role="option"
                  aria-selected={option.value === selectedValue}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))
            ) : (
              <div className="empty compact">No options match.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  sort,
  setSort,
  empty,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: {
  rows: T[];
  columns: Array<{
    key: string;
    label: string;
    className?: string;
    sortable?: boolean;
    render?: (row: T) => ReactNode;
  }>;
  sort: SortState;
  setSort: (sort: SortState) => void;
  empty: string;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  aria-sort={
                    sort.key === column.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  {column.sortable === false ? (
                    column.label
                  ) : (
                    <button
                      className="sort"
                      onClick={() =>
                        setSort(
                          sort.key === column.key
                            ? { key: column.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
                            : { key: column.key, dir: 'asc' },
                        )
                      }
                    >
                      {column.label}
                      {sort.key === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={String(row.id || `${index}`)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render ? column.render(row) : String(row[column.key] ?? '-')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span className="hint">
          Showing {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, rows.length)} of{' '}
          {rows.length}
        </span>
        <SearchableSelect
          className="page-size-select"
          value={String(pageSize)}
          onChange={(value) => {
            setPageSize(Number(value));
            setPage(1);
          }}
          options={[
            { value: '10', label: '10 rows' },
            { value: '25', label: '25 rows' },
            { value: '50', label: '50 rows' },
          ]}
        />
        <Button onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage === 1}>
          Previous
        </Button>
        <Button
          onClick={() => setPage(Math.min(totalPages, safePage + 1))}
          disabled={safePage === totalPages}
        >
          Next
        </Button>
        {hasMore && onLoadMore && (
          <Button onClick={onLoadMore} loading={loadingMore} disabled={loadingMore}>
            Load 50 more
          </Button>
        )}
      </div>
    </>
  );
}

function TableToolbar({
  title,
  hint,
  filters,
  setFilters,
  options,
}: {
  title: string;
  hint: string;
  filters: { q: string; status: string };
  setFilters: (filters: { q: string; status: string }) => void;
  options: string[];
}) {
  return (
    <div className="table-tools">
      <div>
        <h3>{title}</h3>
        <div className="hint">{hint}</div>
      </div>
      <div className="filters">
        <label className="search">
          <Search />
          <input
            aria-label={`${title} search`}
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            placeholder={`Search ${title.toLowerCase()}`}
          />
        </label>
        <SearchableSelect
          value={filters.status}
          onChange={(value) => setFilters({ ...filters, status: value })}
          options={[
            { value: 'all', label: 'All statuses' },
            ...options.map((option) => ({ value: option, label: titleCase(option) })),
          ]}
        />
      </div>
    </div>
  );
}

function SectionErrors({
  errors,
  sections,
  onRetry,
}: {
  errors: Partial<Record<SectionKey, string>>;
  sections: SectionKey[];
  onRetry?: () => void;
}) {
  const entries = sections
    .map((section) => [section, errors[section]] as const)
    .filter((entry): entry is readonly [SectionKey, string] => Boolean(entry[1]));

  if (!entries.length) return null;

  return (
    <div className="inline-error">
      <strong>Some dashboard data failed to load.</strong>
      <p>Check the admin API, then retry the failed section.</p>
      {entries.map(([section, message]) => (
        <div className="error-row" key={section}>
          <span>
            <strong>{titleCase(section)}</strong>: {message}
          </span>
          {onRetry && (
            <Button tone="utility" onClick={onRetry}>
              Retry section
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function RecordDetails({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <div className="detail-list">
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <span>{label}</span>
          <code>{formatDetailValue(value)}</code>
        </div>
      ))}
    </div>
  );
}

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(themeKey);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeControl({
  mode,
  resolvedTheme,
  setMode,
}: {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}) {
  const options: Array<{ id: ThemeMode; label: string; icon: ReactNode }> = [
    { id: 'system', label: `System (${resolvedTheme})`, icon: <Monitor /> },
    { id: 'light', label: 'Light', icon: <Sun /> },
    { id: 'dark', label: 'Dark', icon: <Moon /> },
  ];

  return (
    <div className="theme-control" role="group" aria-label="Theme">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={mode === option.id}
          onClick={() => setMode(option.id)}
          title={option.label}
        >
          {option.icon}
          <span>{option.id}</span>
        </button>
      ))}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
  className = '',
  quiet,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  quiet?: boolean;
}) {
  return (
    <section className={`panel ${quiet ? 'quiet' : ''} ${className}`}>
      {title && <h3>{title}</h3>}
      {subtitle && <p className="sub">{subtitle}</p>}
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  badge,
}: {
  label: string;
  value: string | number;
  badge?: ReactNode;
}) {
  return (
    <div className="card metric">
      <div>
        <div className="value">{typeof value === 'number' ? formatNumber(value) : value}</div>
        <div className="label">{label}</div>
      </div>
      {badge}
    </div>
  );
}

function DashboardStatusBadge({
  token,
  loading,
  hasLoaded,
  hasFailures,
}: {
  token: string;
  loading: boolean;
  hasLoaded: boolean;
  hasFailures: boolean;
}) {
  if (loading) return <Badge tone="info">Loading dashboard</Badge>;
  if (!token.trim()) return <Badge tone="warn">Token required</Badge>;
  if (hasFailures) return <Badge tone="warn">Some data failed</Badge>;
  if (hasLoaded) return <Badge tone="ok">Current</Badge>;
  return <Badge tone="info">Token loaded</Badge>;
}

function AdminSessionMenu({
  token,
  updateToken,
  lastRefresh,
}: {
  token: string;
  updateToken: (value: string) => void;
  lastRefresh: Date | null;
}) {
  return (
    <details className="session-details">
      <summary>
        <MoreHorizontal />
        <span className="visually-hidden">Admin session</span>
      </summary>
      <div className="session-popover">
        <label className="field">
          <span>Admin token</span>
          <input
            aria-label="Admin token"
            type="password"
            value={token}
            onChange={(event) => updateToken(event.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
          />
        </label>
        <div className="meta-line">
          Last loaded: {lastRefresh ? formatRelativeDate(lastRefresh) : 'Never'}
        </div>
      </div>
    </details>
  );
}

function ToastView({ toast, close }: { toast: Exclude<Toast, null>; close: () => void }) {
  return (
    <div className={`toast ${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
      <span>{toast.message}</span>
      {toast.persistent && (
        <button className="toast-close" onClick={close} aria-label="Dismiss notification">
          Dismiss
        </button>
      )}
    </div>
  );
}

function PendingBadge({ children }: { children: ReactNode }) {
  return (
    <Badge tone="info">
      <Loader2 className="spin tiny" />
      {children}
    </Badge>
  );
}

function ActionMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; onClick: () => void; danger?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const button = buttonRef.current;
      const menu = menuRef.current;
      if (!button || !menu) return;

      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const margin = 8;
      const opensUpward =
        buttonRect.bottom + margin + menuRect.height > window.innerHeight - margin;
      setPosition({
        left: Math.max(
          margin,
          Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width - margin),
        ),
        top: opensUpward
          ? Math.max(margin, buttonRect.top - menuRect.height - margin)
          : buttonRect.bottom + margin,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target))
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="action-menu">
      <Button
        ref={buttonRef}
        tone="utility"
        icon={<MoreHorizontal />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="visually-hidden">{label}</span>
      </Button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="action-menu-popover action-menu-floating"
            role="menu"
            style={position ?? { visibility: 'hidden' }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                className={item.danger ? 'danger-item' : ''}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function RelativeTime({
  value,
  empty = 'Never',
}: {
  value?: string | Date | null;
  empty?: string;
}) {
  if (!value) return <span className="hint">{empty}</span>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="hint">{empty}</span>;
  return (
    <span title={formatDate(date)}>
      {formatRelativeDate(date)}
      <span className="hint block">{formatDate(date)}</span>
    </span>
  );
}

function usageUserId(row: UsageGroup) {
  return row.user?.id || (typeof row.userId === 'string' ? row.userId : 'unknown');
}

function activityUser(row: ActivityLog) {
  return row.user?.name || row.user?.email || row.userId || 'Unknown';
}

function activityClient(row: ActivityLog) {
  return [row.clientName, row.clientVersion].filter(Boolean).join('@') || 'Unknown';
}

function activityStatusTone(status: string): Tone {
  if (status === 'success') return 'ok';
  if (status === 'error' || status === 'budget_exceeded') return 'danger';
  if (status === 'rate_limited') return 'warn';
  return 'info';
}

function usageUserLabel(row: UsageGroup) {
  if (row.user) return `${row.user.name} <${row.user.email}>`;
  if (row.userId && row.userId !== 'unknown') return String(row.userId);
  return 'Unknown attribution';
}

function usageGroupLabel(row: UsageGroup, key: string) {
  if (key === 'team') return row.team?.name || row.team?.slug || 'Unknown team';
  if (key === 'key') return String(row.key?.name || row.keyId || row.keyAlias || 'Unknown key');
  if (key === 'name') return String(row.name || 'Unknown');
  return String(row[key] || 'Unknown');
}

function formatMoney(value: unknown) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function rankUsageRows(rows: UsageGroup[], metric: UsageMetric) {
  return [...rows].sort((a, b) => Number(b[metric] || 0) - Number(a[metric] || 0));
}

function usageMetricLabel(metric: UsageMetric) {
  if (metric === 'estimatedCost') return 'Cost';
  if (metric === 'totalTokens') return 'Tokens';
  if (metric === 'requests') return 'Requests';
  return 'Errors';
}

function usagePresetLabel(value: string) {
  if (value === 'allTime') return 'All time';
  if (value === 'thisWeek') return 'This week';
  if (value === 'thisMonth') return 'This month';
  if (value === 'lastMonth') return 'Last month';
  if (value === 'last7') return 'Last 7 days';
  if (value === 'today') return 'Today';
  if (value === 'yesterday') return 'Yesterday';
  return 'Custom range';
}

function usagePresetRange(value: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (value === 'allTime') return { from: '', to: '' };
  if (value === 'today') return { from: iso(today), to: iso(addDays(today, 1)) };
  if (value === 'yesterday') return { from: iso(addDays(today, -1)), to: iso(today) };
  if (value === 'thisWeek') {
    const day = today.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    return { from: iso(addDays(today, mondayOffset)), to: iso(addDays(today, 1)) };
  }
  if (value === 'thisMonth') {
    return {
      from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: iso(addDays(today, 1)),
    };
  }
  if (value === 'lastMonth') {
    return {
      from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    };
  }
  return { from: iso(addDays(today, -6)), to: iso(addDays(today, 1)) };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function exportUsageCsv(filename: string, rows: UsageGroup[]) {
  const headers = ['name', 'requests', 'totalTokens', 'estimatedCost', 'errors', 'lastUsage'];
  const csv = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((header) => csvCell(header === 'name' ? usageExportName(row) : row[header]))
        .join(','),
    ),
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function usageExportName(row: UsageGroup) {
  return (
    row.user?.email ||
    row.team?.name ||
    row.key?.name ||
    row.name ||
    row.model ||
    row.date ||
    'Unknown'
  );
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function OneTimeSecretPanel({
  value,
  copied,
  setCopied,
  notify,
  dismiss,
}: {
  value: string;
  copied: boolean;
  setCopied: (copied: boolean) => void;
  notify: (message: string, tone?: Tone) => void;
  dismiss: () => void;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    notify('Developer key copied.');
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="secret one-time-secret">
      <div>
        <strong>Developer key created</strong>
        <p>Copy this key now. It will not be shown again.</p>
      </div>
      <code>{value}</code>
      <div className="actions">
        <Button tone="primary" icon={copied ? <Check /> : <Copy />} onClick={copy}>
          {copied ? 'Copied' : 'Copy key'}
        </Button>
        <Button tone="utility" onClick={dismiss}>
          I saved this key
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  required,
  full,
  type = 'text',
  ...props
}: {
  label: string;
  name: string;
  required?: boolean;
  full?: boolean;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
}) {
  return (
    <label className={`field ${full ? 'full' : ''}`}>
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      <input name={name} required={required} type={type} {...props} />
    </label>
  );
}

const Button = forwardRef<
  HTMLButtonElement,
  {
    children: ReactNode;
    icon?: ReactNode;
    tone?: 'primary' | 'secondary' | 'utility' | 'danger' | 'danger-ghost';
    loading?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function Button({ children, icon, tone, loading, ...props }, ref) {
  return (
    <button ref={ref} className={tone || 'secondary'} {...props}>
      {loading ? <Loader2 className="spin" /> : icon}
      {children}
    </button>
  );
});

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}

function providerBadge(provider: Provider) {
  if (!provider.enabled) return <Badge tone="off">Disabled</Badge>;
  if (provider.healthStatus === 'healthy') return <Badge tone="ok">Healthy</Badge>;
  if (provider.healthStatus === 'unhealthy') return <Badge tone="danger">Unhealthy</Badge>;
  return <Badge tone="warn">Unchecked</Badge>;
}

function getGatewayReadiness({
  failedSections,
  enabledProviders,
  enabledAliases,
  activeKeys,
  unhealthy,
  lastRefresh,
}: {
  failedSections: number;
  enabledProviders: number;
  enabledAliases: number;
  activeKeys: number;
  unhealthy: boolean;
  lastRefresh: Date | null;
}) {
  if (!lastRefresh) {
    return {
      tone: 'warn' as Tone,
      badge: 'Not loaded',
      title: 'Load dashboard data',
      description:
        'Connect with an admin token to check provider health, aliases, keys, and usage.',
      action: 'Load dashboard',
    };
  }
  if (failedSections) {
    return {
      tone: 'warn' as Tone,
      badge: 'Partial data',
      title: 'Some dashboard data needs a retry',
      description: `${failedSections} section${failedSections === 1 ? '' : 's'} failed to load. Loaded sections may still be current.`,
      action: 'Retry dashboard',
    };
  }
  if (unhealthy) {
    return {
      tone: 'danger' as Tone,
      badge: 'Needs attention',
      title: 'Provider health is degraded',
      description: 'Check unhealthy providers before issuing or routing more developer traffic.',
      action: 'Reload dashboard',
    };
  }
  if (!enabledProviders) {
    return {
      tone: 'warn' as Tone,
      badge: 'Setup incomplete',
      title: 'Add a provider first',
      description: 'A provider is required before aliases and developer keys can route traffic.',
      action: 'Reload dashboard',
    };
  }
  if (!enabledAliases) {
    return {
      tone: 'warn' as Tone,
      badge: 'Setup incomplete',
      title: 'Create a model alias',
      description: 'Developers need stable aliases such as code-premium before keys are useful.',
      action: 'Reload dashboard',
    };
  }
  if (!activeKeys) {
    return {
      tone: 'info' as Tone,
      badge: 'Ready for access',
      title: 'Issue the first developer key',
      description:
        'Providers and aliases are ready. Create personal developer keys to start usage.',
      action: 'Reload dashboard',
    };
  }
  return {
    tone: 'ok' as Tone,
    badge: 'Ready',
    title: 'Gateway is ready',
    description: 'Providers, aliases, and active developer keys are available for daily operation.',
    action: 'Reload dashboard',
  };
}

function sectionTone(status: LoadStatus): Tone {
  if (status === 'current') return 'ok';
  if (status === 'stale' || status === 'loading') return 'warn';
  if (status === 'failed') return 'danger';
  return 'off';
}

function sectionLabel(status: LoadStatus) {
  if (status === 'idle') return 'Not loaded';
  if (status === 'loading') return 'Loading';
  return titleCase(status);
}

function hasSectionData(section: SectionKey, data: DashboardData) {
  if (section === 'usage') return Boolean(data.usage);
  return data[section].length > 0;
}

function affectedAliases(aliases: ModelAlias[], providerId: string) {
  return aliases.filter((alias) => alias.enabled && alias.provider?.id === providerId).length;
}

function objectRows(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).filter(([, item]) => typeof item !== 'object' || item === null);
}

function formatDetailValue(value: unknown) {
  if (value == null || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function useRows<T extends Record<string, unknown>>(
  rows: T[],
  filters: { q: string; status: string },
  sort: SortState,
  keys: Array<keyof T | ((row: T) => unknown)>,
) {
  return useMemo(() => {
    const q = filters.q.toLowerCase();
    const filtered = rows.filter((row) => {
      const matchesQuery =
        !q ||
        keys.some((key) =>
          String(typeof key === 'function' ? key(row) : row[key] || '')
            .toLowerCase()
            .includes(q),
        );
      const statusValue =
        'status' in row
          ? row.status
          : 'enabled' in row
            ? (row as { enabled?: boolean }).enabled
              ? 'enabled'
              : 'disabled'
            : undefined;
      const healthValue = 'healthStatus' in row ? row.healthStatus || 'unchecked' : undefined;
      const matchesStatus =
        filters.status === 'all' ||
        statusValue === filters.status ||
        healthValue === filters.status;
      return matchesQuery && matchesStatus;
    });
    return sortRows(filtered, sort);
  }, [rows, filters, sort, keys]);
}

function sortRows<T extends Record<string, unknown>>(rows: T[], sort: SortState) {
  return [...rows].sort(
    (a, b) => compare(a[sort.key], b[sort.key]) * (sort.dir === 'asc' ? 1 : -1),
  );
}

function compare(a: unknown, b: unknown) {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function formatDate(value?: string | Date | null) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

function formatRelativeDate(value?: string | Date | null) {
  if (!value) return 'Never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  const diff = Date.now() - date.getTime();
  const abs = Math.abs(diff);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < minute) return 'Just now';
  if (abs < hour) return rtf.format(Math.round(-diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(-diff / hour), 'hour');
  return rtf.format(Math.round(-diff / day), 'day');
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

declare global {
  interface Window {
    __loomToastTimer?: number;
  }
}
