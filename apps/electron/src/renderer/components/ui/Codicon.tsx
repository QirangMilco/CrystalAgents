import { cn } from '@/lib/utils'

interface CodiconProps {
  name: string
  className?: string
}

export function Codicon({ name, className }: CodiconProps) {
  return <span aria-hidden="true" className={cn('codicon', `codicon-${name}`, className)} />
}
