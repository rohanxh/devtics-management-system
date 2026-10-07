import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const INK = '#64748b';
const GRID = '#e2e8f0';
export const SERIES = '#4f46e5';

const tooltipStyle = { fontSize: 12, borderRadius: 6, border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,.08)' };

/** Single-series bar chart (one hue; the card title names the series). Tooltip on hover. */
export function SimpleBars({ data, x, y, format, height = 220, horizontal, target, targetLabel }: {
  data: any[]; x: string; y: string; format?: (v: number) => string; height?: number; horizontal?: boolean; target?: number; targetLabel?: string;
}) {
  const fmt = format ?? ((v: number) => v.toLocaleString());
  return (
    <div style={{ height }} role="img" aria-label={`Bar chart of ${y} by ${x}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, bottom: 0, left: horizontal ? 8 : 0 }} barCategoryGap={horizontal ? 6 : '25%'}>
          <CartesianGrid stroke={GRID} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={{ fill: INK, fontSize: 11 }} tickFormatter={fmt} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey={x} width={110} tick={{ fill: INK, fontSize: 11 }} axisLine={false} tickLine={false} />
            </>
          ) : (
            <>
              <XAxis dataKey={x} tick={{ fill: INK, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} />
              <YAxis tick={{ fill: INK, fontSize: 11 }} tickFormatter={fmt} axisLine={false} tickLine={false} width={56} />
            </>
          )}
          <Tooltip cursor={{ fill: 'rgba(99,102,241,.06)' }} contentStyle={tooltipStyle} formatter={(v) => [fmt(Number(v)), '']} separator="" />
          {target !== undefined && (
            horizontal
              ? <ReferenceLine x={target} stroke={INK} strokeDasharray="4 3" label={{ value: targetLabel, fill: INK, fontSize: 10, position: 'top' }} />
              : <ReferenceLine y={target} stroke={INK} strokeDasharray="4 3" label={{ value: targetLabel, fill: INK, fontSize: 10, position: 'right' }} />
          )}
          <Bar dataKey={y} fill={SERIES} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
