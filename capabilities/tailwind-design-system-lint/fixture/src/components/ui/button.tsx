type ButtonProps = {
  className?: string
  size?: "default" | "sm" | "lg"
}

export function Button({ className, size = "default" }: ButtonProps) {
  return <button className={className} data-size={size} />
}
