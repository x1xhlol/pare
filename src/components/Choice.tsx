import { useId, type ReactNode } from 'react'

export type Option<T extends string> = {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

type Props<T extends string> = {
  legend: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  hint?: ReactNode
  disabled?: boolean
}

export function Choice<T extends string>({ legend, value, options, onChange, hint, disabled }: Props<T>) {
  const name = useId()
  return (
    <fieldset className="choice" disabled={disabled}>
      <legend className="choice-legend">{legend}</legend>
      <div className="segmented" data-count={options.length}>
        {options.map((o) => (
          <label key={o.value} className="segment" title={o.title} data-disabled={o.disabled || undefined}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="choice-hint">{hint}</p>}
    </fieldset>
  )
}
