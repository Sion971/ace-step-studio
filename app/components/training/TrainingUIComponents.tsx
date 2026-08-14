import React from 'react';

export const Section: React.FC<{ title: string | React.ReactNode; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
    <h3 className="text-xs font-semibold text-zinc-300 mb-2">{title}</h3>
    {children}
  </div>
);

export const FieldRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2">
    <label className="text-[11px] text-zinc-500 w-28 flex-shrink-0">{label}</label>
    {children}
  </div>
);

export const ParamSlider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, onChange }) => (
  <div>
    <div className="flex items-center justify-between mb-0.5">
      <label className="text-[11px] text-zinc-500">{label}</label>
      <span className="text-[11px] text-zinc-400 font-mono">{step < 1 ? value.toFixed(2) : value}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(parseFloat(e.target.value))}
      className="w-full accent-pink-500 h-1.5"
    />
  </div>
);
