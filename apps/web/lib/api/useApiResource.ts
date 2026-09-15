'use client';

import { useCallback, useEffect, useState } from 'react';

export type ResourceState = 'loading' | 'ready' | 'error';

export interface ApiResource<T> {
  data: T | null;
  state: ResourceState;
  error: string | null;
  /** Re-run the fetch (used by the retry button and after mutations). */
  reload: () => void;
}

/**
 * Minimal data-fetching hook — no external library. Handles loading/error and
 * an abortable reload, and cancels in-flight requests on unmount so state is
 * never set after teardown.
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<ResourceState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState('loading');
    setError(null);

    fetcher(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setState('ready');
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os dados.');
        setState('error');
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, state, error, reload };
}
