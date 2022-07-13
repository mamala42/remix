// TODO: We eventually might not want to import anything directly from `history`
// and leverage `react-router` here instead
import type { Action, Location } from "history";
import type {
  FocusEventHandler,
  FormHTMLAttributes,
  MouseEventHandler,
  TouchEventHandler,
  SuspenseProps,
} from "react";
import * as React from "react";
import type { Navigator, Params } from "react-router";
import {
  Router,
  Link as RouterLink,
  NavLink as RouterNavLink,
  useLocation,
  useRoutes,
  useNavigate,
  useHref,
  useResolvedPath,
} from "react-router-dom";
import type { LinkProps, NavLinkProps } from "react-router-dom";
import type { Deferrable, ResolvedDeferrable } from "@remix-run/deferred";

import type { AppData, FormEncType, FormMethod } from "./data";
import type { EntryContext, AssetsManifest } from "./entry";
import type { AppState, SerializedError } from "./errors";
import {
  RemixRootDefaultErrorBoundary,
  RemixErrorBoundary,
  RemixRootDefaultCatchBoundary,
  RemixCatchBoundary,
} from "./errorBoundaries";
import invariant from "./invariant";
import {
  getDataLinkHrefs,
  getLinksForMatches,
  getModuleLinkHrefs,
  getNewMatchesForLinks,
  getStylesheetPrefetchLinks,
  isPageLinkDescriptor,
} from "./links";
import type { HtmlLinkDescriptor, PrefetchPageDescriptor } from "./links";
import { createHtml } from "./markup";
import type { ClientRoute } from "./routes";
import { createClientRoutes } from "./routes";
import type { RouteData, DeferredRouteData } from "./routeData";
import type { RouteMatch as BaseRouteMatch } from "./routeMatching";
import { matchClientRoutes } from "./routeMatching";
import type { RouteModules, HtmlMetaDescriptor } from "./routeModules";
import { createTransitionManager } from "./transition";
import type { Transition, Fetcher, Submission } from "./transition";

const IS_SSR = typeof document === "undefined";

////////////////////////////////////////////////////////////////////////////////
// RemixEntry

interface RemixEntryContextType {
  manifest: AssetsManifest;
  matches: BaseRouteMatch<ClientRoute>[];
  routeData: RouteData;
  routeDataDeferred: DeferredRouteData;
  actionData?: unknown;
  pendingLocation?: Location;
  appState: AppState;
  routeModules: RouteModules;
  serverHandoffString?: string;
  clientRoutes: ClientRoute[];
  transitionManager: ReturnType<typeof createTransitionManager>;
}

export const RemixEntryContext = React.createContext<
  RemixEntryContextType | undefined
>(undefined);

function useRemixEntryContext(): RemixEntryContextType {
  let context = React.useContext(RemixEntryContext);
  invariant(context, "You must render this element inside a <Remix> element");
  return context;
}

export function RemixEntry({
  context: entryContext,
  action,
  location: historyLocation,
  navigator: _navigator,
  static: staticProp = false,
}: {
  context: EntryContext;
  action: Action;
  location: Location;
  navigator: Navigator;
  static?: boolean;
}) {
  let {
    manifest,
    routeData: documentLoaderData,
    deferredRouteData: documentDeferredLoaderData,
    actionData: documentActionData,
    routeModules,
    serverHandoffString,
    appState: entryComponentDidCatchEmulator,
  } = entryContext;

  let clientRoutes = React.useMemo(
    () => createClientRoutes(manifest.routes, routeModules, RemixRoute),
    [manifest, routeModules]
  );

  let [clientState, setClientState] = React.useState(
    entryComponentDidCatchEmulator
  );

  let [transitionManager] = React.useState(() => {
    return createTransitionManager({
      routes: clientRoutes,
      actionData: documentActionData,
      loaderData: documentLoaderData,
      deferredLoaderData: documentDeferredLoaderData,
      location: historyLocation,
      catch: entryComponentDidCatchEmulator.catch,
      catchBoundaryId: entryComponentDidCatchEmulator.catchBoundaryRouteId,
      onRedirect: _navigator.replace,
      onChange: (state) => {
        setClientState({
          catch: state.catch,
          error: state.error,
          catchBoundaryRouteId: state.catchBoundaryId,
          loaderBoundaryRouteId: state.errorBoundaryId,
          renderBoundaryRouteId: null,
          trackBoundaries: false,
          trackCatchBoundaries: false,
        });
      },
    });
  });

  // Ensures pushes interrupting pending navigations use replace
  // TODO: Move this to React Router
  let navigator: Navigator = React.useMemo(() => {
    let push: Navigator["push"] = (to, state) => {
      return transitionManager.getState().transition.state !== "idle"
        ? _navigator.replace(to, state)
        : _navigator.push(to, state);
    };
    return { ..._navigator, push };
  }, [_navigator, transitionManager]);

  let { location, matches, loaderData, deferredLoaderData, actionData } =
    transitionManager.getState();

  // Send new location to the transition manager
  React.useEffect(() => {
    let { location } = transitionManager.getState();
    if (historyLocation === location) return;
    transitionManager.send({
      type: "navigation",
      location: historyLocation,
      submission: consumeNextNavigationSubmission(),
      action,
    });
  }, [transitionManager, historyLocation, action]);

  // If we tried to render and failed, and the app threw before rendering any
  // routes, get the error and pass it to the ErrorBoundary to emulate
  // `componentDidCatch`
  let ssrErrorBeforeRoutesRendered =
    clientState.error &&
    clientState.renderBoundaryRouteId === null &&
    clientState.loaderBoundaryRouteId === null
      ? deserializeError(clientState.error)
      : undefined;

  let ssrCatchBeforeRoutesRendered =
    clientState.catch && clientState.catchBoundaryRouteId === null
      ? clientState.catch
      : undefined;

  return (
    <RemixEntryContext.Provider
      value={{
        matches,
        manifest,
        appState: clientState,
        routeModules,
        serverHandoffString,
        clientRoutes,
        routeData: loaderData,
        routeDataDeferred: deferredLoaderData,
        actionData,
        transitionManager,
      }}
    >
      <RemixErrorBoundary
        location={location}
        component={RemixRootDefaultErrorBoundary}
        error={ssrErrorBeforeRoutesRendered}
      >
        <RemixCatchBoundary
          location={location}
          component={RemixRootDefaultCatchBoundary}
          catch={ssrCatchBeforeRoutesRendered}
        >
          <Router
            navigationType={action}
            location={location}
            navigator={navigator}
            static={staticProp}
          >
            <Routes />
          </Router>
        </RemixCatchBoundary>
      </RemixErrorBoundary>
    </RemixEntryContext.Provider>
  );
}

function deserializeError(data: SerializedError): Error {
  let error = new Error(data.message);
  error.stack = data.stack;
  return error;
}

function Routes() {
  // TODO: Add `renderMatches` function to RR that we can use and then we don't
  // need this component, we can just `renderMatches` from RemixEntry
  let { clientRoutes } = useRemixEntryContext();
  // fallback to the root if we don't have a match
  let element = useRoutes(clientRoutes) || (clientRoutes[0].element as any);
  return element;
}

////////////////////////////////////////////////////////////////////////////////
// RemixRoute

interface RemixRouteContextType {
  data: AppData;
  id: string;
}

const RemixRouteContext = React.createContext<
  RemixRouteContextType | undefined
>(undefined);

function useRemixRouteContext(): RemixRouteContextType {
  let context = React.useContext(RemixRouteContext);
  invariant(context, "You must render this element in a remix route element");
  return context;
}

function DefaultRouteComponent({ id }: { id: string }): React.ReactElement {
  throw new Error(
    `Route "${id}" has no component! Please go add a \`default\` export in the route module file.\n` +
      "If you were trying to navigate or submit to a resource route, use `<a>` instead of `<Link>` or `<Form reloadDocument>`."
  );
}

export function RemixRoute({ id }: { id: string }) {
  let location = useLocation();
  let { routeData, routeModules, appState } = useRemixEntryContext();

  // This checks prevent cryptic error messages such as: 'Cannot read properties of undefined (reading 'root')'
  invariant(
    routeData,
    "Cannot initialize 'routeData'. This normally occurs when you have server code in your client modules.\n" +
      "Check this link for more details:\nhttps://remix.run/pages/gotchas#server-code-in-client-bundles"
  );
  invariant(
    routeModules,
    "Cannot initialize 'routeModules'. This normally occurs when you have server code in your client modules.\n" +
      "Check this link for more details:\nhttps://remix.run/pages/gotchas#server-code-in-client-bundles"
  );

  let data = routeData[id];
  let { default: Component, CatchBoundary, ErrorBoundary } = routeModules[id];
  let element = Component ? <Component /> : <DefaultRouteComponent id={id} />;

  let context: RemixRouteContextType = { data, id };

  if (CatchBoundary) {
    // If we tried to render and failed, and this route threw the error, find it
    // and pass it to the ErrorBoundary to emulate `componentDidCatch`
    let maybeServerCaught =
      appState.catch && appState.catchBoundaryRouteId === id
        ? appState.catch
        : undefined;

    // This needs to run after we check for the error from a previous render,
    // otherwise we will incorrectly render this boundary for a loader error
    // deeper in the tree.
    if (appState.trackCatchBoundaries) {
      appState.catchBoundaryRouteId = id;
    }

    context = maybeServerCaught
      ? {
          id,
          get data() {
            console.error("You cannot `useLoaderData` in a catch boundary.");
            return undefined;
          },
        }
      : { id, data };

    element = (
      <RemixCatchBoundary
        location={location}
        component={CatchBoundary}
        catch={maybeServerCaught}
      >
        {element}
      </RemixCatchBoundary>
    );
  }

  // Only wrap in error boundary if the route defined one, otherwise let the
  // error bubble to the parent boundary. We could default to using error
  // boundaries around every route, but now if the app doesn't want users
  // seeing the default Remix ErrorBoundary component, they *must* define an
  // error boundary for *every* route and that would be annoying. Might as
  // well make it required at that point.
  //
  // By conditionally wrapping like this, we allow apps to define a top level
  // ErrorBoundary component and be done with it. Then, if they want to, they
  // can add more specific boundaries by exporting ErrorBoundary components
  // for whichever routes they please.
  //
  // NOTE: this kind of logic will move into React Router

  if (ErrorBoundary) {
    // If we tried to render and failed, and this route threw the error, find it
    // and pass it to the ErrorBoundary to emulate `componentDidCatch`
    let maybeServerRenderError =
      appState.error &&
      (appState.renderBoundaryRouteId === id ||
        appState.loaderBoundaryRouteId === id)
        ? deserializeError(appState.error)
        : undefined;

    // This needs to run after we check for the error from a previous render,
    // otherwise we will incorrectly render this boundary for a loader error
    // deeper in the tree.
    if (appState.trackBoundaries) {
      appState.renderBoundaryRouteId = id;
    }

    context = maybeServerRenderError
      ? {
          id,
          get data() {
            console.error("You cannot `useLoaderData` in an error boundary.");
            return undefined;
          },
        }
      : { id, data };

    element = (
      <RemixErrorBoundary
        location={location}
        component={ErrorBoundary}
        error={maybeServerRenderError}
      >
        {element}
      </RemixErrorBoundary>
    );
  }

  // It's important for the route context to be above the error boundary so that
  // a call to `useLoaderData` doesn't accidentally get the parents route's data.
  return (
    <RemixRouteContext.Provider value={context}>
      {element}
    </RemixRouteContext.Provider>
  );
}

////////////////////////////////////////////////////////////////////////////////
// Public API

const DEFERRED_PROMISE_PREFIX = "__deferred_promise:";

const deferredContext = React.createContext<
  undefined | { value: unknown; key?: string }
>(undefined);

export interface DeferredResolveRenderFunction<Data> {
  (data: ResolvedDeferrable<Data>): JSX.Element;
}

export interface DeferredProps<Data> {
  fallbackElement?: SuspenseProps["fallback"];
  children: React.ReactNode | DeferredResolveRenderFunction<Data>;
  value: Data;
  errorElement?: React.ReactNode;
  nonce?: string;
}

const js = String.raw;

export function Deferred<Data = any>({
  children,
  value,
  errorElement,
  fallbackElement,
  nonce,
}: DeferredProps<Data>) {
  let { routeDataDeferred } = useRemixEntryContext();
  let { id } = useRemixRouteContext();

  // When deferred is used, we receive a string that indicates that
  // this is key is a deferred promise. We use this to know where
  // to grab the running promise from.
  let suspenseDataKey: string | undefined = undefined;
  if (typeof value === "string" && value.startsWith(DEFERRED_PROMISE_PREFIX)) {
    suspenseDataKey = value.slice(DEFERRED_PROMISE_PREFIX.length);
  }

  // If we have a suspenseDataKey, we need to grab the promise from the
  // running promise map.
  if (suspenseDataKey) {
    value = routeDataDeferred[id][suspenseDataKey] as unknown as Data;
  }

  return (
    <deferredContext.Provider
      value={{
        value,
        key: suspenseDataKey,
      }}
    >
      <React.Suspense fallback={fallbackElement}>
        <DeferredErrorBoundary errorElement={errorElement} nonce={nonce}>
          {typeof children === "function" ? (
            <ResolveDeferred
              children={children as DeferredResolveRenderFunction<Data>}
            />
          ) : (
            children
          )}
        </DeferredErrorBoundary>
      </React.Suspense>
      {/* 
        When we have an in-flight deferred promise, we need to keep track of it to
        know when it resolves. Since we can't serialize a promise over the network
        we store it on the remix context. We store a map of promises keyed by the
        route id and deferred key. We also store a resolve function that is used by
        the DeferredHydrationScript to ultimately resolve the promise.
       */}
      {suspenseDataKey && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: js`(() => {
  var promise, resolver;
  promise = new Promise((resolve) => {
    resolver = resolve;
  });
  window.__remixContext = window.__remixContext || { deferredRouteData: {}, deferredRouteDataResolvers: {} };
  window.__remixContext.deferredRouteData[${JSON.stringify(
    id
  )}] = Object.assign(
    {},
    window.__remixContext.deferredRouteData[${JSON.stringify(id)}],
    {
      [${JSON.stringify(suspenseDataKey)}]: promise,
    }
  );
  window.__remixContext.deferredRouteDataResolvers[${JSON.stringify(
    id
  )}] = Object.assign(
    {},
    window.__remixContext.deferredRouteDataResolvers[${JSON.stringify(id)}],
    {
      [${JSON.stringify(suspenseDataKey)}]: resolver
    }
  );
})();`,
          }}
        />
      )}
    </deferredContext.Provider>
  );
}

export function useDeferredData<Data>() {
  let ctx = React.useContext(deferredContext);
  return ctx?.value as ResolvedDeferrable<Data>;
}

export interface ResolveDeferredProps<Data> {
  children: DeferredResolveRenderFunction<Data>;
}

export function ResolveDeferred<Data>({
  children,
}: ResolveDeferredProps<Data>) {
  let data = useDeferredData<Data>();
  return children(data);
}

function DeferredErrorBoundary({
  children,
  errorElement,
  nonce,
}: {
  children: React.ReactNode;
  errorElement?: React.ReactNode;
  nonce?: string;
}) {
  let ctx = React.useContext(deferredContext);
  invariant(ctx, "Deferred must be used inside a DeferredProvider");
  let { value } = ctx;

  let child = children;

  let promise = value as PromiseLike<unknown>;
  // If the deferred data is a promise we suspend at this point.
  if (typeof promise === "object" && promise.then) {
    // We also need to store the resolved data / error on the context for SSR.
    // On page transitions the transition manager takes care of reconciling the
    // resolved data with the route data and re-rendering, but SSR we can't do
    // that so we have to just store it on the context for immediate usage.
    throw promise.then(
      (value) => {
        if (ctx) {
          ctx.value = value;
        }
      },
      (error) => {
        if (ctx) {
          ctx.value = error;
        }
      }
    );
  }

  // If there is an error we render the error element.
  if (value instanceof Error) {
    // If we don't have an errorElement we re-throw the
    // error to bubble it up the component stack to the
    // closest boundary. We can't just throw on the server
    // though as we've already sent the parent components
    // to the browser. In this case we don't render anything
    // and reconcile the UX on the client. This means inline
    // boundaries will be SSR'd, while errors that need to
    // bubble will bubble on the client as parent components
    // need to re-render.
    if (typeof errorElement === "undefined" && !IS_SSR) {
      throw value;
    }

    // If a single use defined component is rendered, clone
    // it and pass it an error prop.
    child =
      typeof errorElement === "object" &&
      errorElement &&
      "type" in errorElement &&
      typeof errorElement.type === "function"
        ? React.cloneElement(errorElement, { error: value })
        : errorElement;
  }

  return (
    <>
      {child}
      <DeferredHydrationScript nonce={nonce} />
    </>
  );
}

function DeferredHydrationScript({ nonce }: { nonce?: string }) {
  let { id } = useRemixRouteContext();
  let ctx = React.useContext(deferredContext);
  invariant(ctx, "Deferred must be used inside a DeferredProvider");
  let { value, key } = ctx;

  if (!key) return null;

  // Serialize the data / error for transmission to the client.
  let preHydration = "",
    hydrationValue;
  if (value instanceof Error) {
    preHydration = `let error = new Error(${JSON.stringify(
      value.message
    )});error.stack = ${JSON.stringify(value.stack)};`;
    hydrationValue = `error`;
  } else {
    hydrationValue = JSON.stringify(value);
  }

  // This script uses the resolve function stored on the remix context
  // to resolve the deferred promise based on the resolved data / error.
  return (
    <script
      nonce={nonce}
      dangerouslySetInnerHTML={{
        __html: js`(() => {
${preHydration}
window.__remixContext.deferredRouteData[${JSON.stringify(id)}] = Object.assign(
  {},
  window.__remixContext.deferredRouteData[${JSON.stringify(id)}],
  {
    [${JSON.stringify(key)}]: ${hydrationValue},
  }
);
window.__remixContext.deferredRouteDataResolvers[${JSON.stringify(
          id
        )}][${JSON.stringify(key)}](
  window.__remixContext.deferredRouteData[${JSON.stringify(
    id
  )}][${JSON.stringify(key)}]
);
})();`,
      }}
    />
  );
}

/**
 * Defines the prefetching behavior of the link:
 *
 * - "intent": Fetched when the user focuses or hovers the link
 * - "render": Fetched when the link is rendered
 * - "none": Never fetched
 */
type PrefetchBehavior = "intent" | "render" | "none";

export interface RemixLinkProps extends LinkProps {
  prefetch?: PrefetchBehavior;
}

export interface RemixNavLinkProps extends NavLinkProps {
  prefetch?: PrefetchBehavior;
}

interface PrefetchHandlers {
  onFocus?: FocusEventHandler<Element>;
  onBlur?: FocusEventHandler<Element>;
  onMouseEnter?: MouseEventHandler<Element>;
  onMouseLeave?: MouseEventHandler<Element>;
  onTouchStart?: TouchEventHandler<Element>;
}

function usePrefetchBehavior(
  prefetch: PrefetchBehavior,
  theirElementProps: PrefetchHandlers
): [boolean, Required<PrefetchHandlers>] {
  let [maybePrefetch, setMaybePrefetch] = React.useState(false);
  let [shouldPrefetch, setShouldPrefetch] = React.useState(false);
  let { onFocus, onBlur, onMouseEnter, onMouseLeave, onTouchStart } =
    theirElementProps;

  React.useEffect(() => {
    if (prefetch === "render") {
      setShouldPrefetch(true);
    }
  }, [prefetch]);

  let setIntent = () => {
    if (prefetch === "intent") {
      setMaybePrefetch(true);
    }
  };

  let cancelIntent = () => {
    if (prefetch === "intent") {
      setMaybePrefetch(false);
      setShouldPrefetch(false);
    }
  };

  React.useEffect(() => {
    if (maybePrefetch) {
      let id = setTimeout(() => {
        setShouldPrefetch(true);
      }, 100);
      return () => {
        clearTimeout(id);
      };
    }
  }, [maybePrefetch]);

  return [
    shouldPrefetch,
    {
      onFocus: composeEventHandlers(onFocus, setIntent),
      onBlur: composeEventHandlers(onBlur, cancelIntent),
      onMouseEnter: composeEventHandlers(onMouseEnter, setIntent),
      onMouseLeave: composeEventHandlers(onMouseLeave, cancelIntent),
      onTouchStart: composeEventHandlers(onTouchStart, setIntent),
    },
  ];
}

/**
 * A special kind of `<Link>` that knows whether or not it is "active".
 *
 * @see https://remix.run/api/remix#navlink
 */
let NavLink = React.forwardRef<HTMLAnchorElement, RemixNavLinkProps>(
  ({ to, prefetch = "none", ...props }, forwardedRef) => {
    let href = useHref(to);
    let [shouldPrefetch, prefetchHandlers] = usePrefetchBehavior(
      prefetch,
      props
    );
    return (
      <>
        <RouterNavLink
          ref={forwardedRef}
          to={to}
          {...props}
          {...(typeof prefetchHandlers === "object"
            ? { ...prefetchHandlers }
            : {})}
        />
        {shouldPrefetch ? <PrefetchPageLinks page={href} /> : null}
      </>
    );
  }
);
NavLink.displayName = "NavLink";
export { NavLink };
/**
 * This component renders an anchor tag and is the primary way the user will
 * navigate around your website.
 *
 * @see https://remix.run/api/remix#link
 */
let Link = React.forwardRef<HTMLAnchorElement, RemixLinkProps>(
  ({ to, prefetch = "none", ...props }, forwardedRef) => {
    let href = useHref(to);
    let [shouldPrefetch, prefetchHandlers] = usePrefetchBehavior(
      prefetch,
      props
    );
    return (
      <>
        <RouterLink
          ref={forwardedRef}
          to={to}
          {...props}
          {...(typeof prefetchHandlers === "object" ? prefetchHandlers : {})}
        />
        {shouldPrefetch ? <PrefetchPageLinks page={href} /> : null}
      </>
    );
  }
);
Link.displayName = "Link";
export { Link };

export function composeEventHandlers<
  EventType extends React.SyntheticEvent | Event
>(
  theirHandler: ((event: EventType) => any) | undefined,
  ourHandler: (event: EventType) => any
): (event: EventType) => any {
  return (event) => {
    theirHandler && theirHandler(event);
    if (!event.defaultPrevented) {
      ourHandler(event);
    }
  };
}

/**
 * Renders the `<link>` tags for the current routes.
 *
 * @see https://remix.run/api/remix#meta-links-scripts
 */
export function Links() {
  let { matches, routeModules, manifest } = useRemixEntryContext();

  let links = React.useMemo(
    () => getLinksForMatches(matches, routeModules, manifest),
    [matches, routeModules, manifest]
  );

  return (
    <>
      {links.map((link) => {
        if (isPageLinkDescriptor(link)) {
          return <PrefetchPageLinks key={link.page} {...link} />;
        }

        let imageSrcSet: string | null = null;

        // In React 17, <link imageSrcSet> and <link imageSizes> will warn
        // because the DOM attributes aren't recognized, so users need to pass
        // them in all lowercase to forward the attributes to the node without a
        // warning. Normalize so that either property can be used in Remix.
        if ("useId" in React) {
          if (link.imagesrcset) {
            link.imageSrcSet = imageSrcSet = link.imagesrcset;
            delete link.imagesrcset;
          }

          if (link.imagesizes) {
            link.imageSizes = link.imagesizes;
            delete link.imagesizes;
          }
        } else {
          if (link.imageSrcSet) {
            link.imagesrcset = imageSrcSet = link.imageSrcSet;
            delete link.imageSrcSet;
          }

          if (link.imageSizes) {
            link.imagesizes = link.imageSizes;
            delete link.imageSizes;
          }
        }

        return (
          <link
            key={link.rel + (link.href || "") + (imageSrcSet || "")}
            {...link}
          />
        );
      })}
    </>
  );
}

/**
 * This component renders all of the `<link rel="prefetch">` and
 * `<link rel="modulepreload"/>` tags for all the assets (data, modules, css) of
 * a given page.
 *
 * @param props
 * @param props.page
 * @see https://remix.run/api/remix#prefetchpagelinks-
 */
export function PrefetchPageLinks({
  page,
  ...dataLinkProps
}: PrefetchPageDescriptor) {
  let { clientRoutes } = useRemixEntryContext();
  let matches = React.useMemo(
    () => matchClientRoutes(clientRoutes, page),
    [clientRoutes, page]
  );

  if (!matches) {
    console.warn(`Tried to prefetch ${page} but no routes matched.`);
    return null;
  }

  return (
    <PrefetchPageLinksImpl page={page} matches={matches} {...dataLinkProps} />
  );
}

function usePrefetchedStylesheets(matches: BaseRouteMatch<ClientRoute>[]) {
  let { routeModules } = useRemixEntryContext();

  let [styleLinks, setStyleLinks] = React.useState<HtmlLinkDescriptor[]>([]);

  React.useEffect(() => {
    let interrupted: boolean = false;

    getStylesheetPrefetchLinks(matches, routeModules).then((links) => {
      if (!interrupted) setStyleLinks(links);
    });

    return () => {
      interrupted = true;
    };
  }, [matches, routeModules]);

  return styleLinks;
}

function PrefetchPageLinksImpl({
  page,
  matches: nextMatches,
  ...linkProps
}: PrefetchPageDescriptor & {
  matches: BaseRouteMatch<ClientRoute>[];
}) {
  let location = useLocation();
  let { matches, manifest } = useRemixEntryContext();

  let newMatchesForData = React.useMemo(
    () => getNewMatchesForLinks(page, nextMatches, matches, location, "data"),
    [page, nextMatches, matches, location]
  );

  let newMatchesForAssets = React.useMemo(
    () => getNewMatchesForLinks(page, nextMatches, matches, location, "assets"),
    [page, nextMatches, matches, location]
  );

  let dataHrefs = React.useMemo(
    () => getDataLinkHrefs(page, newMatchesForData, manifest),
    [newMatchesForData, page, manifest]
  );

  let moduleHrefs = React.useMemo(
    () => getModuleLinkHrefs(newMatchesForAssets, manifest),
    [newMatchesForAssets, manifest]
  );

  // needs to be a hook with async behavior because we need the modules, not
  // just the manifest like the other links in here.
  let styleLinks = usePrefetchedStylesheets(newMatchesForAssets);

  return (
    <>
      {dataHrefs.map((href) => (
        <link key={href} rel="prefetch" as="fetch" href={href} {...linkProps} />
      ))}
      {moduleHrefs.map((href) => (
        <link key={href} rel="modulepreload" href={href} {...linkProps} />
      ))}
      {styleLinks.map((link) => (
        // these don't spread `linkProps` because they are full link descriptors
        // already with their own props
        <link key={link.href} {...link} />
      ))}
    </>
  );
}

/**
 * Renders the `<title>` and `<meta>` tags for the current routes.
 *
 * @see https://remix.run/api/remix#meta-links-scripts
 */
export function Meta() {
  let { matches, routeData, routeModules } = useRemixEntryContext();
  let location = useLocation();

  let meta: HtmlMetaDescriptor = {};
  let parentsData: { [routeId: string]: AppData } = {};

  for (let match of matches) {
    let routeId = match.route.id;
    let data = routeData[routeId];
    let params = match.params;

    let routeModule = routeModules[routeId];

    if (routeModule.meta) {
      let routeMeta =
        typeof routeModule.meta === "function"
          ? routeModule.meta({ data, parentsData, params, location })
          : routeModule.meta;
      Object.assign(meta, routeMeta);
    }

    parentsData[routeId] = data;
  }

  return (
    <>
      {Object.entries(meta).map(([name, value]) => {
        if (!value) {
          return null;
        }

        if (["charset", "charSet"].includes(name)) {
          return <meta key="charset" charSet={value as string} />;
        }

        if (name === "title") {
          return <title key="title">{value as string}</title>;
        }

        // Open Graph tags use the `property` attribute, while other meta tags
        // use `name`. See https://ogp.me/
        let isOpenGraphTag = name.startsWith("og:");
        return [value].flat().map((content) => {
          if (isOpenGraphTag) {
            return (
              <meta
                content={content as string}
                key={name + content}
                property={name}
              />
            );
          }

          if (typeof content === "string") {
            return <meta content={content} name={name} key={name + content} />;
          }

          return <meta key={name + JSON.stringify(content)} {...content} />;
        });
      })}
    </>
  );
}

/**
 * Tracks whether Remix has finished hydrating or not, so scripts can be skipped
 * during client-side updates.
 */
let isHydrated = false;

type ScriptProps = Omit<
  React.HTMLProps<HTMLScriptElement>,
  | "children"
  | "async"
  | "defer"
  | "src"
  | "type"
  | "noModule"
  | "dangerouslySetInnerHTML"
  | "suppressHydrationWarning"
>;

/**
 * Renders the `<script>` tags needed for the initial render. Bundles for
 * additional routes are loaded later as needed.
 *
 * @param props Additional properties to add to each script tag that is rendered.
 * In addition to scripts, \<link rel="modulepreload"> tags receive the crossOrigin
 * property if provided.
 *
 * @see https://remix.run/api/remix#meta-links-scripts
 */
export function Scripts(props: ScriptProps) {
  let {
    manifest,
    matches,
    pendingLocation,
    clientRoutes,
    serverHandoffString,
  } = useRemixEntryContext();

  React.useEffect(() => {
    isHydrated = true;
  }, []);

  let initialScripts = React.useMemo(() => {
    let contextScript = serverHandoffString
      ? `window.__remixContext = Object.assign({}, ${serverHandoffString}, window.__remixContext);`
      : "";

    let routeModulesScript = `${matches
      .map(
        (match, index) =>
          `import * as route${index} from ${JSON.stringify(
            manifest.routes[match.route.id].module
          )};`
      )
      .join("\n")}
window.__remixRouteModules = {${matches
      .map((match, index) => `${JSON.stringify(match.route.id)}:route${index}`)
      .join(",")}};
      
import(${JSON.stringify(manifest.entry.module)});`;

    return (
      <>
        <script
          {...props}
          suppressHydrationWarning
          dangerouslySetInnerHTML={createHtml(contextScript)}
          type={undefined}
        />
        <script {...props} type={undefined} src={manifest.url} />
        <script
          {...props}
          dangerouslySetInnerHTML={createHtml(routeModulesScript)}
          type="module"
          async
        />
      </>
    );
    // disabled deps array because we are purposefully only rendering this once
    // for hydration, after that we want to just continue rendering the initial
    // scripts as they were when the page first loaded
    // eslint-disable-next-line
  }, []);

  // avoid waterfall when importing the next route module
  let nextMatches = React.useMemo(() => {
    if (pendingLocation) {
      // FIXME: can probably use transitionManager `nextMatches`
      let matches = matchClientRoutes(clientRoutes, pendingLocation);
      invariant(matches, `No routes match path "${pendingLocation.pathname}"`);
      return matches;
    }

    return [];
  }, [pendingLocation, clientRoutes]);

  let routePreloads = matches
    .concat(nextMatches)
    .map((match) => {
      let route = manifest.routes[match.route.id];
      return (route.imports || []).concat([route.module]);
    })
    .flat(1);

  let preloads = manifest.entry.imports.concat(routePreloads);

  return (
    <>
      <link
        rel="modulepreload"
        href={manifest.entry.module}
        crossOrigin={props.crossOrigin}
      />
      {dedupe(preloads).map((path) => (
        <link
          key={path}
          rel="modulepreload"
          href={path}
          crossOrigin={props.crossOrigin}
        />
      ))}
      {isHydrated ? null : initialScripts}
    </>
  );
}

function dedupe(array: any[]) {
  return [...new Set(array)];
}

export interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  /**
   * The HTTP verb to use when the form is submit. Supports "get", "post",
   * "put", "delete", "patch".
   *
   * Note: If JavaScript is disabled, you'll need to implement your own "method
   * override" to support more than just GET and POST.
   */
  method?: FormMethod;

  /**
   * Normal `<form action>` but supports React Router's relative paths.
   */
  action?: string;

  /**
   * Normal `<form encType>`.
   *
   * Note: Remix defaults to `application/x-www-form-urlencoded` and also
   * supports `multipart/form-data`.
   */
  encType?: FormEncType;

  /**
   * Forces a full document navigation instead of a fetch.
   */
  reloadDocument?: boolean;

  /**
   * Replaces the current entry in the browser history stack when the form
   * navigates. Use this if you don't want the user to be able to click "back"
   * to the page with the form on it.
   */
  replace?: boolean;

  /**
   * A function to call when the form is submitted. If you call
   * `event.preventDefault()` then this form will not do anything.
   */
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}

/**
 * A Remix-aware `<form>`. It behaves like a normal form except that the
 * interaction with the server is with `fetch` instead of new document
 * requests, allowing components to add nicer UX to the page as the form is
 * submitted and returns with data.
 *
 * @see https://remix.run/api/remix#form
 */
let Form = React.forwardRef<HTMLFormElement, FormProps>((props, ref) => {
  return <FormImpl {...props} ref={ref} />;
});
Form.displayName = "Form";
export { Form };

interface FormImplProps extends FormProps {
  fetchKey?: string;
}

let FormImpl = React.forwardRef<HTMLFormElement, FormImplProps>(
  (
    {
      reloadDocument = false,
      replace = false,
      method = "get",
      action = ".",
      encType = "application/x-www-form-urlencoded",
      fetchKey,
      onSubmit,
      ...props
    },
    forwardedRef
  ) => {
    let submit = useSubmitImpl(fetchKey);
    let formMethod: FormMethod =
      method.toLowerCase() === "get" ? "get" : "post";
    let formAction = useFormAction(action);

    return (
      <form
        ref={forwardedRef}
        method={formMethod}
        action={formAction}
        encType={encType}
        onSubmit={
          reloadDocument
            ? undefined
            : (event) => {
                onSubmit && onSubmit(event);
                if (event.defaultPrevented) return;
                event.preventDefault();

                let submitter = (event as unknown as HTMLSubmitEvent)
                  .nativeEvent.submitter as HTMLFormSubmitter | null;

                submit(submitter || event.currentTarget, { method, replace });
              }
        }
        {...props}
      />
    );
  }
);
FormImpl.displayName = "FormImpl";
export { FormImpl };

type HTMLSubmitEvent = React.BaseSyntheticEvent<
  SubmitEvent,
  Event,
  HTMLFormElement
>;

type HTMLFormSubmitter = HTMLButtonElement | HTMLInputElement;

/**
 * Resolves a `<form action>` path relative to the current route.
 *
 * @see https://remix.run/api/remix#useformaction
 */
export function useFormAction(
  action = ".",
  // TODO: Remove method param in v2 as it's no longer needed and is a breaking change
  method: FormMethod = "get"
): string {
  let { id } = useRemixRouteContext();
  let path = useResolvedPath(action);
  let search = path.search;
  let isIndexRoute = id.endsWith("/index");

  if (action === "." && isIndexRoute) {
    search = search ? search.replace(/^\?/, "?index&") : "?index";
  }

  return path.pathname + search;
}

export interface SubmitOptions {
  /**
   * The HTTP method used to submit the form. Overrides `<form method>`.
   * Defaults to "GET".
   */
  method?: FormMethod;

  /**
   * The action URL path used to submit the form. Overrides `<form action>`.
   * Defaults to the path of the current route.
   *
   * Note: It is assumed the path is already resolved. If you need to resolve a
   * relative path, use `useFormAction`.
   */
  action?: string;

  /**
   * The action URL used to submit the form. Overrides `<form encType>`.
   * Defaults to "application/x-www-form-urlencoded".
   */
  encType?: FormEncType;

  /**
   * Set `true` to replace the current entry in the browser's history stack
   * instead of creating a new one (i.e. stay on "the same page"). Defaults
   * to `false`.
   */
  replace?: boolean;
}

/**
 * Submits a HTML `<form>` to the server without reloading the page.
 */
export interface SubmitFunction {
  (
    /**
     * Specifies the `<form>` to be submitted to the server, a specific
     * `<button>` or `<input type="submit">` to use to submit the form, or some
     * arbitrary data to submit.
     *
     * Note: When using a `<button>` its `name` and `value` will also be
     * included in the form data that is submitted.
     */
    target:
      | HTMLFormElement
      | HTMLButtonElement
      | HTMLInputElement
      | FormData
      | URLSearchParams
      | { [name: string]: string }
      | null,

    /**
     * Options that override the `<form>`'s own attributes. Required when
     * submitting arbitrary data without a backing `<form>`.
     */
    options?: SubmitOptions
  ): void;
}

/**
 * Returns a function that may be used to programmatically submit a form (or
 * some arbitrary data) to the server.
 *
 * @see https://remix.run/api/remix#usesubmit
 */
export function useSubmit(): SubmitFunction {
  return useSubmitImpl();
}

let defaultMethod = "get";
let defaultEncType = "application/x-www-form-urlencoded";

export function useSubmitImpl(key?: string): SubmitFunction {
  let navigate = useNavigate();
  let defaultAction = useFormAction();
  let { transitionManager } = useRemixEntryContext();

  return React.useCallback(
    (target, options = {}) => {
      let method: string;
      let action: string;
      let encType: string;
      let formData: FormData;

      if (isFormElement(target)) {
        let submissionTrigger: HTMLButtonElement | HTMLInputElement = (
          options as any
        ).submissionTrigger;

        method =
          options.method || target.getAttribute("method") || defaultMethod;
        action =
          options.action || target.getAttribute("action") || defaultAction;
        encType =
          options.encType || target.getAttribute("enctype") || defaultEncType;

        formData = new FormData(target);

        if (submissionTrigger && submissionTrigger.name) {
          formData.append(submissionTrigger.name, submissionTrigger.value);
        }
      } else if (
        isButtonElement(target) ||
        (isInputElement(target) &&
          (target.type === "submit" || target.type === "image"))
      ) {
        let form = target.form;

        if (form == null) {
          throw new Error(`Cannot submit a <button> without a <form>`);
        }

        // <button>/<input type="submit"> may override attributes of <form>

        method =
          options.method ||
          target.getAttribute("formmethod") ||
          form.getAttribute("method") ||
          defaultMethod;
        action =
          options.action ||
          target.getAttribute("formaction") ||
          form.getAttribute("action") ||
          defaultAction;
        encType =
          options.encType ||
          target.getAttribute("formenctype") ||
          form.getAttribute("enctype") ||
          defaultEncType;
        formData = new FormData(form);

        // Include name + value from a <button>
        if (target.name) {
          formData.set(target.name, target.value);
        }
      } else {
        if (isHtmlElement(target)) {
          throw new Error(
            `Cannot submit element that is not <form>, <button>, or ` +
              `<input type="submit|image">`
          );
        }

        method = options.method || "get";
        action = options.action || defaultAction;
        encType = options.encType || "application/x-www-form-urlencoded";

        if (target instanceof FormData) {
          formData = target;
        } else {
          formData = new FormData();

          if (target instanceof URLSearchParams) {
            for (let [name, value] of target) {
              formData.append(name, value);
            }
          } else if (target != null) {
            for (let name of Object.keys(target)) {
              formData.append(name, target[name]);
            }
          }
        }
      }

      if (IS_SSR) {
        throw new Error(
          "You are calling submit during the server render. " +
            "Try calling submit within a `useEffect` or callback instead."
        );
      }

      let { protocol, host } = window.location;
      let url = new URL(action, `${protocol}//${host}`);

      if (method.toLowerCase() === "get") {
        for (let [name, value] of formData) {
          if (typeof value === "string") {
            url.searchParams.append(name, value);
          } else {
            throw new Error(`Cannot submit binary form data using GET`);
          }
        }
      }

      let submission: Submission = {
        formData,
        action: url.pathname + url.search,
        method: method.toUpperCase(),
        encType,
        key: Math.random().toString(36).substr(2, 8),
      };

      if (key) {
        transitionManager.send({
          type: "fetcher",
          href: submission.action,
          submission,
          key,
        });
      } else {
        setNextNavigationSubmission(submission);
        navigate(url.pathname + url.search, { replace: options.replace });
      }
    },
    [defaultAction, key, navigate, transitionManager]
  );
}

let nextNavigationSubmission: Submission | undefined;

function setNextNavigationSubmission(submission: Submission) {
  nextNavigationSubmission = submission;
}

function consumeNextNavigationSubmission() {
  let submission = nextNavigationSubmission;
  nextNavigationSubmission = undefined;
  return submission;
}

function isHtmlElement(object: any): object is HTMLElement {
  return object != null && typeof object.tagName === "string";
}

function isButtonElement(object: any): object is HTMLButtonElement {
  return isHtmlElement(object) && object.tagName.toLowerCase() === "button";
}

function isFormElement(object: any): object is HTMLFormElement {
  return isHtmlElement(object) && object.tagName.toLowerCase() === "form";
}

function isInputElement(object: any): object is HTMLInputElement {
  return isHtmlElement(object) && object.tagName.toLowerCase() === "input";
}

/**
 * Setup a callback to be fired on the window's `beforeunload` event. This is
 * useful for saving some data to `window.localStorage` just before the page
 * refreshes, which automatically happens on the next `<Link>` click when Remix
 * detects a new version of the app is available on the server.
 *
 * Note: The `callback` argument should be a function created with
 * `React.useCallback()`.
 *
 * @see https://remix.run/api/remix#usebeforeunload
 */
export function useBeforeUnload(callback: () => any): void {
  React.useEffect(() => {
    window.addEventListener("beforeunload", callback);
    return () => {
      window.removeEventListener("beforeunload", callback);
    };
  }, [callback]);
}

export interface RouteMatch {
  /**
   * The id of the matched route
   */
  id: string;
  /**
   * The pathname of the matched route
   */
  pathname: string;
  /**
   * The dynamic parameters of the matched route
   *
   * @see https://remix.run/docs/api/conventions#dynamic-route-parameters
   */
  params: Params<string>;
  /**
   * Any route data associated with the matched route
   */
  data: RouteData;
  /**
   * The exported `handle` object of the matched route.
   *
   * @see https://remix.run/docs/api/conventions#handle
   */
  handle: undefined | { [key: string]: any };
}

/**
 * Returns the current route matches on the page. This is useful for creating
 * layout abstractions with your current routes.
 *
 * @see https://remix.run/api/remix#usematches
 */
export function useMatches(): RouteMatch[] {
  let { matches, routeData, routeModules } = useRemixEntryContext();

  return React.useMemo(
    () =>
      matches.map((match) => {
        let { pathname, params } = match;
        return {
          id: match.route.id,
          pathname,
          params,
          data: routeData[match.route.id],
          // if the module fails to load or an error/response is thrown, the module
          // won't be defined.
          handle: routeModules[match.route.id]?.handle,
        };
      }),
    [matches, routeData, routeModules]
  );
}

/**
 * Returns the JSON parsed data from the current route's `loader`.
 *
 * @see https://remix.run/api/remix#useloaderdata
 */

export type TypedResponse<T> = Response & {
  json(): Promise<T>;
};

type DataFunction = (...args: any[]) => unknown; // matches any function

type DataOrFunction = AppData | DataFunction;

type JsonPrimitives =
  | string
  | number
  | boolean
  | String
  | Number
  | Boolean
  | null;

type NonJsonPrimitives = undefined | Function | symbol;

type SerializeType<T, UseDeferred = false> = T extends JsonPrimitives
  ? T
  : T extends NonJsonPrimitives
  ? never
  : T extends { toJSON(): infer U }
  ? U
  : T extends []
  ? []
  : T extends [unknown, ...unknown[]]
  ? {
      [k in keyof T]: T[k] extends NonJsonPrimitives
        ? null
        : SerializeType<T[k]>;
    }
  : T extends (infer U)[]
  ? (U extends NonJsonPrimitives ? null : SerializeType<U>)[]
  : T extends object
  ? {
      [k in keyof T as T[k] extends NonJsonPrimitives
        ? UseDeferred extends true
          ? k
          : never
        : k]: UseDeferred extends true
        ? T[k] extends Deferrable<unknown>
          ? Deferrable<ResolvedDeferrable<T[k]>>
          : SerializeType<T[k]>
        : SerializeType<T[k]>;
    }
  : never;

export type UseDataFunctionReturn<T extends DataOrFunction> = T extends (
  ...args: any[]
) => infer Output
  ? Awaited<Output> extends TypedResponse<infer U>
    ? SerializeType<U>
    : SerializeType<Awaited<ReturnType<T>>>
  : SerializeType<Awaited<T>>;

export function useLoaderData<T = AppData>(): UseDataFunctionReturn<T> {
  return useRemixRouteContext().data;
}

/**
 * Returns the JSON parsed data from the current route's `action`.
 *
 * @see https://remix.run/api/remix#useactiondata
 */
export function useActionData<T = AppData>():
  | UseDataFunctionReturn<T>
  | undefined {
  let { id: routeId } = useRemixRouteContext();
  let { transitionManager } = useRemixEntryContext();
  let { actionData } = transitionManager.getState();
  return actionData ? actionData[routeId] : undefined;
}

/**
 * Returns everything you need to know about a page transition to build pending
 * navigation indicators and optimistic UI on data mutations.
 *
 * @see https://remix.run/api/remix#usetransition
 */
export function useTransition(): Transition {
  let { transitionManager } = useRemixEntryContext();
  return transitionManager.getState().transition;
}

function createFetcherForm(fetchKey: string) {
  let FetcherForm = React.forwardRef<HTMLFormElement, FormProps>(
    (props, ref) => {
      // TODO: make ANOTHER form w/o a fetchKey prop
      return <FormImpl {...props} ref={ref} fetchKey={fetchKey} />;
    }
  );
  FetcherForm.displayName = "fetcher.Form";
  return FetcherForm;
}

let fetcherId = 0;

export type FetcherWithComponents<TData> = Fetcher<TData> & {
  Form: React.ForwardRefExoticComponent<
    FormProps & React.RefAttributes<HTMLFormElement>
  >;
  submit: SubmitFunction;
  load: (href: string) => void;
};

/**
 * Interacts with route loaders and actions without causing a navigation. Great
 * for any interaction that stays on the same page.
 *
 * @see https://remix.run/api/remix#usefetcher
 */
export function useFetcher<TData = any>(): FetcherWithComponents<TData> {
  let { transitionManager } = useRemixEntryContext();

  let [key] = React.useState(() => String(++fetcherId));
  let [Form] = React.useState(() => createFetcherForm(key));
  let [load] = React.useState(() => (href: string) => {
    transitionManager.send({ type: "fetcher", href, key });
  });
  let submit = useSubmitImpl(key);

  let fetcher = transitionManager.getFetcher<TData>(key);

  let fetcherWithComponents = React.useMemo(
    () => ({
      Form,
      submit,
      load,
      ...fetcher,
    }),
    [fetcher, Form, submit, load]
  );

  React.useEffect(() => {
    // Is this busted when the React team gets real weird and calls effects
    // twice on mount?  We really just need to garbage collect here when this
    // fetcher is no longer around.
    return () => transitionManager.deleteFetcher(key);
  }, [transitionManager, key]);

  return fetcherWithComponents;
}

/**
 * Provides all fetchers currently on the page. Useful for layouts and parent
 * routes that need to provide pending/optimistic UI regarding the fetch.
 *
 * @see https://remix.run/api/remix#usefetchers
 */
export function useFetchers(): Fetcher[] {
  let { transitionManager } = useRemixEntryContext();
  let { fetchers } = transitionManager.getState();
  return [...fetchers.values()];
}

// Dead Code Elimination magic for production builds.
// This way devs don't have to worry about doing the NODE_ENV check themselves.
// If running an un-bundled server outside of `remix dev` you will still need
// to set the REMIX_DEV_SERVER_WS_PORT manually.
export const LiveReload =
  process.env.NODE_ENV !== "development"
    ? () => null
    : function LiveReload({
        port = Number(process.env.REMIX_DEV_SERVER_WS_PORT || 8002),
        nonce = undefined,
      }: {
        port?: number;
        /**
         * @deprecated this property is no longer relevant.
         */
        nonce?: string;
      }) {
        let js = String.raw;
        return (
          <script
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: js`
                (() => {
                  let protocol = location.protocol === "https:" ? "wss:" : "ws:";
                  let host = location.hostname;
                  let socketPath = protocol + "//" + host + ":" + ${String(
                    port
                  )} + "/socket";

                  let ws = new WebSocket(socketPath);
                  ws.onmessage = (message) => {
                    let event = JSON.parse(message.data);
                    if (event.type === "LOG") {
                      console.log(event.message);
                    }
                    if (event.type === "RELOAD") {
                      console.log("💿 Reloading window ...");
                      window.location.reload();
                    }
                  };
                  ws.onerror = (error) => {
                    console.log("Remix dev asset server web socket error:");
                    console.error(error);
                  };
                })();
              `,
            }}
          />
        );
      };
