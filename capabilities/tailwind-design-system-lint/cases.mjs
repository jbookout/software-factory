export const SEEDS={
  "raw-color.tsx": "export function RawColor() { return <div className=\"bg-pink-500\" /> }\n",
  "arbitrary.tsx": "export function Arbitrary() { return <div className=\"p-[13px]\" /> }\n",
  "restyle.tsx": "import { Button } from \"./components/ui/button\"\nexport function Restyle() { return <Button className=\"bg-primary\" /> }\n",
  "inline.tsx": "export function Inline() { return <div style={{ borderRadius: 13 }} /> }\n",
  "dynamic.tsx": "import { Button } from \"./components/ui/button\"\nexport function Dynamic({tone}: {tone:string}) { return <Button className={tone} /> }\n",
  "custom-properties.tsx": "export function Custom({space}: {space:string}) { return <div style={{\"--space\":space} as React.CSSProperties} className=\"mt-4\" /> }\n",
  "unicode.tsx": "import { Button } from \"./components/ui/button\"\nconst label=\"🧭 café\"; export function Unicode() { return <Button className=\"bg-pink-500\" /> }\n",
  "crlf.tsx": "import { Button } from \"./components/ui/button\"\r\nexport function CrLf() { return <Button className=\"p-[13px]\" /> }\r\n",
  "typo.tsx": "export function Typo() { return <div className=\"bg-prmary\" /> }\n",
  "components/ui/overrides.tsx": "import { Button } from \"./button\"\nexport function Override({tone}: {tone:string}) { return <Button className={`bg-pink-500 p-[13px] ${tone} factory-not-a-real-class`} style={{borderRadius:13}} /> }\n"
}
