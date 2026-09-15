import { Button } from "./components/ui/button"

export function InvalidExample({ tone }: { tone: string }) {
  return (
    <Button
      className={`bg-pink-500 p-[13px] ${tone}`}
      style={{ borderRadius: 13 }}
    />
  )
}
