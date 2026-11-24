'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import {
  DOWNLOADER_STATE_KEY,
  QUEUE_UI_STATE_KEY,
  readPersistedDownloaderState,
  readPersistedQueueUiState,
  swrJsonFetcher,
} from '@/lib/swrStore';

function SwrSessionHydrator() {
  const { cache, mutate } = useSWRConfig();

  useEffect(() => {
    if (cache.get(DOWNLOADER_STATE_KEY)?.data === undefined) {
      const persistedDownloader = readPersistedDownloaderState();
      if (persistedDownloader) {
        void mutate(DOWNLOADER_STATE_KEY, persistedDownloader, { revalidate: false });
      }
    }

    if (cache.get(QUEUE_UI_STATE_KEY)?.data === undefined) {
      const persistedQueueUi = readPersistedQueueUiState();
      if (persistedQueueUi) {
        void mutate(QUEUE_UI_STATE_KEY, persistedQueueUi, { revalidate: false });
      }
    }
  }, [cache, mutate]);

  return null;
}

export function SWRProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map());

  return (
    <SWRConfig
      value={{
        provider: () => cache,
        fetcher: swrJsonFetcher,
        dedupingInterval: 2000,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
      }}
    >
      <SwrSessionHydrator />
      {children}
    </SWRConfig>
  );
}
