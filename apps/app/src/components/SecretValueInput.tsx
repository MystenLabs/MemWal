import type { InputHTMLAttributes } from 'react'

interface SecretValueInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children' | 'readOnly' | 'type' | 'value'> {
    value: string
    masked?: boolean
    maskLength?: number
}

export function SecretValueInput({
    value,
    masked = false,
    maskLength = 48,
    className,
    onFocus,
    placeholder,
    ...props
}: SecretValueInputProps) {
    return (
        <input
            {...props}
            className={className ? `secret-value-input ${className}` : 'secret-value-input'}
            type="text"
            value={masked ? '' : value}
            placeholder={masked ? '•'.repeat(maskLength) : placeholder}
            readOnly
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-analytics-redact="true"
            onFocus={(event) => {
                if (!masked) event.currentTarget.select()
                onFocus?.(event)
            }}
        />
    )
}
