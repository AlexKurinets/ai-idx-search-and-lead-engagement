'use client';

import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { shortMoney } from '@/lib/format';
import type { Card, Cluster } from '@/lib/types';

export interface GeoPayload {
  neighborhoods: GeoJSON.FeatureCollection;
  parks: GeoJSON.FeatureCollection;
  rivers: GeoJSON.FeatureCollection;
}

interface Props {
  geo: GeoPayload | null;
  center: [number, number];
  zoom?: number;
  results?: Card[];
  clusters?: Cluster[] | null;
  highlight?: GeoJSON.Geometry | null;
  fitKey?: string;
  onViewport?: (bbox: [number, number, number, number], zoom: number) => void;
  onSelect?: (id: string) => void;
  className?: string;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function centroid(geometry: GeoJSON.Geometry): [number, number] {
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : [];
  const pts = ring.slice(0, -1);
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/**
 * The search map. There is no tile server: the style draws the synthetic geography
 * (neighborhood polygons shaded by median list price, parks and the river) and the
 * listings on top. Below the cluster zoom the API returns geotile clusters; above it,
 * individual listings, so the phone only ever receives what is on screen.
 */
export default function SearchMap({ geo, center, zoom = 11.3, results = [], clusters = null, highlight = null, fitKey, onViewport, onSelect, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const labels = useRef<Marker[]>([]);
  const lib = useRef<typeof import('maplibre-gl') | null>(null);
  const skipMove = useRef(false);
  const ready = useRef(false);
  // A fit requested while the map is hidden (phone list view) waits until it has a size.
  const pendingFit = useRef<[[number, number], [number, number]] | null>(null);
  const cb = useRef({ onViewport, onSelect });
  cb.current = { onViewport, onSelect };

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const maplibre = await import('maplibre-gl');
      if (disposed || !el.current) return;
      lib.current = maplibre;
      const m = new maplibre.Map({
        container: el.current,
        style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': css('--map-bg') } }] },
        center,
        zoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
      m.touchZoomRotate.disableRotation();
      const observer = new ResizeObserver(() => {
        if (!el.current || el.current.clientWidth === 0) return;
        m.resize();
        if (pendingFit.current) {
          skipMove.current = true;
          m.fitBounds(pendingFit.current, { padding: 60, maxZoom: 14.5, duration: 0 });
          pendingFit.current = null;
        }
      });
      observer.observe(el.current);
      m.once('remove', () => observer.disconnect());
      m.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
      map.current = m;
      m.on('load', () => {
        ready.current = true;
        m.addSource('hoods', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addSource('parks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addSource('rivers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addSource('highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({
          id: 'hood-fill',
          type: 'fill',
          source: 'hoods',
          paint: {
            'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'median_price'], 0],
              200000, css('--ord-1'), 450000, css('--ord-2'), 700000, css('--ord-3'), 1000000, css('--ord-4')],
            'fill-opacity': 0.16,
          },
        });
        m.addLayer({ id: 'hood-line', type: 'line', source: 'hoods', paint: { 'line-color': css('--map-line'), 'line-width': 1 } });
        m.addLayer({ id: 'parks', type: 'fill', source: 'parks', paint: { 'fill-color': css('--map-park'), 'fill-opacity': 0.9 } });
        m.addLayer({ id: 'rivers', type: 'line', source: 'rivers', paint: { 'line-color': css('--map-water'), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 9] } });
        m.addLayer({ id: 'highlight-fill', type: 'fill', source: 'highlight', paint: { 'fill-color': css('--accent'), 'fill-opacity': 0.14 } });
        m.addLayer({ id: 'highlight-line', type: 'line', source: 'highlight', paint: { 'line-color': css('--accent'), 'line-width': 2 } });
        m.addLayer({
          id: 'pins',
          type: 'circle',
          source: 'pins',
          paint: { 'circle-radius': 7, 'circle-color': css('--series-1'), 'circle-stroke-color': css('--surface'), 'circle-stroke-width': 2 },
        });
        m.on('click', 'pins', (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) cb.current.onSelect?.(String(id));
        });
        m.on('mouseenter', 'pins', () => (m.getCanvas().style.cursor = 'pointer'));
        m.on('mouseleave', 'pins', () => (m.getCanvas().style.cursor = ''));
        m.fire('idx:sync');
      });
      m.on('moveend', () => {
        if (skipMove.current) {
          skipMove.current = false;
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          const b = m.getBounds();
          cb.current.onViewport?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], m.getZoom());
        }, 350);
      });
      m.on('zoomend', () => {
        const show = m.getZoom() >= 11;
        labels.current.forEach((l) => (l.getElement().style.display = show ? '' : 'none'));
      });
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      map.current?.remove();
      map.current = null;
      ready.current = false;
    };
    // The map is created once; props flow in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Static geography and neighborhood labels.
  useEffect(() => {
    const m = map.current;
    const apply = () => {
      const mm = map.current;
      if (!mm || !geo || !lib.current) return;
      (mm.getSource('hoods') as GeoJSONSource | undefined)?.setData(geo.neighborhoods);
      (mm.getSource('parks') as GeoJSONSource | undefined)?.setData(geo.parks);
      (mm.getSource('rivers') as GeoJSONSource | undefined)?.setData(geo.rivers);
      labels.current.forEach((l) => l.remove());
      labels.current = geo.neighborhoods.features.map((f) => {
        const div = document.createElement('div');
        div.className = 'text-[11px] font-medium text-muted pointer-events-none select-none';
        div.textContent = String(f.properties?.name ?? '');
        return new lib.current!.Marker({ element: div }).setLngLat(centroid(f.geometry)).addTo(mm);
      });
    };
    if (m && ready.current) apply();
    else if (m) m.once('idx:sync', apply);
    else {
      const t = setInterval(() => {
        if (map.current) {
          clearInterval(t);
          if (ready.current) apply();
          else map.current.once('idx:sync', apply);
        }
      }, 100);
      return () => clearInterval(t);
    }
  }, [geo]);

  // Listings, clusters and the highlighted polygon.
  useEffect(() => {
    const apply = () => {
      const m = map.current;
      if (!m || !lib.current || !ready.current) return;
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      const pins: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: clusters ? [] : results.map((r) => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'Point', coordinates: [r.location.lon, r.location.lat] } })),
      };
      (m.getSource('pins') as GeoJSONSource | undefined)?.setData(pins);
      (m.getSource('highlight') as GeoJSONSource | undefined)?.setData(
        highlight ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: highlight }] } : { type: 'FeatureCollection', features: [] },
      );
      if (clusters) {
        const max = Math.max(1, ...clusters.map((c) => c.count));
        for (const c of clusters) {
          const size = Math.round(26 + 22 * Math.sqrt(c.count / max));
          const div = document.createElement('button');
          div.type = 'button';
          div.className = 'map-marker flex items-center justify-center rounded-full border-2 border-[var(--surface)] text-[11px] font-semibold text-white shadow';
          div.style.cssText = `width:${size}px;height:${size}px;background:var(--series-1)`;
          div.title = `${c.count.toLocaleString('en-US')} homes from ${shortMoney(c.min_price)}`;
          div.textContent = c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : String(c.count);
          div.onclick = () => m.easeTo({ center: [c.lon, c.lat], zoom: Math.min(16, m.getZoom() + 2) });
          markers.current.push(new lib.current.Marker({ element: div }).setLngLat([c.lon, c.lat]).addTo(m));
        }
      } else if (results.length <= 80) {
        for (const r of results) {
          const div = document.createElement('button');
          div.type = 'button';
          div.className = 'map-marker -translate-y-4 rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-ink shadow-sm';
          div.textContent = shortMoney(r.price);
          div.onclick = () => cb.current.onSelect?.(r.id);
          markers.current.push(new lib.current.Marker({ element: div }).setLngLat([r.location.lon, r.location.lat]).addTo(m));
        }
      }
    };
    const applyAndFit = () => {
      apply();
      maybeFit.current();
    };
    if (ready.current) applyAndFit();
    else map.current?.once('idx:sync', applyAndFit);
  }, [results, clusters, highlight]);

  // Fit to the result set when a new search (not a pan) produced it. Called from the data
  // effect too, so a fit requested before the map finished loading is not lost.
  const lastFit = useRef<string | undefined>(undefined);
  const latest = useRef({ results, clusters, highlight, fitKey });
  latest.current = { results, clusters, highlight, fitKey };
  const maybeFit = useRef(() => {
    const m = map.current;
    const { results: rs, clusters: cs, highlight: hl, fitKey: key } = latest.current;
    if (!m || !ready.current || !key || key === lastFit.current) return;
    const pts = cs?.length ? cs.map((c) => [c.lon, c.lat]) : rs.map((r) => [r.location.lon, r.location.lat]);
    if (hl && hl.type === 'Polygon') pts.push(...hl.coordinates[0]);
    if (!pts.length) return;
    lastFit.current = key;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const bounds: [[number, number], [number, number]] = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    if (!el.current || el.current.clientWidth === 0) {
      pendingFit.current = bounds;
      return;
    }
    skipMove.current = true;
    m.fitBounds(bounds, { padding: 60, maxZoom: 14.5, duration: 600 });
  });

  useEffect(() => {
    maybeFit.current();
  }, [fitKey, results, clusters]);

  return <div ref={el} className={className ?? 'h-full w-full'} />;
}
