/** A deterministic illustration standing in for listing photos (the photo feed is not replicated here). */
export default function HomeArt({ id, subType, className }: { id: string; subType: string | null; className?: string }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = 150 + (h % 90);
  const sky = `hsl(${hue} 45% 86%)`;
  const ground = `hsl(${hue} 30% 72%)`;
  const wall = `hsl(${(hue + 160) % 360} 25% 94%)`;
  const roof = `hsl(${(hue + 180) % 360} 22% 38%)`;
  const condo = subType === 'condo';
  const town = subType === 'townhouse';
  return (
    <svg viewBox="0 0 160 100" className={className} role="img" aria-label="Home illustration" preserveAspectRatio="xMidYMid slice">
      <rect width="160" height="100" fill={sky} />
      <rect y="74" width="160" height="26" fill={ground} />
      {condo ? (
        <g>
          <rect x="52" y="22" width="56" height="54" fill={wall} />
          {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={58 + c * 17} y={28 + r * 15} width="10" height="9" fill={roof} opacity="0.55" />))}
        </g>
      ) : town ? (
        <g>
          {[0, 1, 2].map((i) => (
            <g key={i} transform={`translate(${36 + i * 30} 0)`}>
              <polygon points="0,46 15,32 30,46" fill={roof} />
              <rect x="2" y="46" width="26" height="30" fill={wall} />
              <rect x="11" y="60" width="8" height="16" fill={roof} opacity="0.7" />
            </g>
          ))}
        </g>
      ) : (
        <g>
          <polygon points="48,48 80,24 112,48" fill={roof} />
          <rect x="54" y="48" width="52" height="28" fill={wall} />
          <rect x="74" y="58" width="12" height="18" fill={roof} opacity="0.7" />
          <rect x="60" y="54" width="9" height="8" fill={roof} opacity="0.45" />
          <rect x="91" y="54" width="9" height="8" fill={roof} opacity="0.45" />
        </g>
      )}
    </svg>
  );
}
