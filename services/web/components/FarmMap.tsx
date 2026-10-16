'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { GeoPayload } from './SearchMap';

const SearchMap = dynamic(() => import('./SearchMap'), { ssr: false, loading: () => <div className="h-full w-full bg-[var(--map-bg)]" /> });

export default function FarmMap({ office, geometry }: { office: string; geometry: GeoJSON.Polygon }) {
  const [geo, setGeo] = useState<GeoPayload | null>(null);
  useEffect(() => {
    fetch(`/api/v1/t/${office}/geo`).then((r) => r.json()).then(setGeo).catch(() => undefined);
  }, [office]);
  const ring = geometry.coordinates[0];
  const center: [number, number] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return (
    <div className="h-72 overflow-hidden rounded-xl border border-line">
      <SearchMap geo={geo} center={center} zoom={12.4} highlight={geometry} fitKey="farm" />
    </div>
  );
}
