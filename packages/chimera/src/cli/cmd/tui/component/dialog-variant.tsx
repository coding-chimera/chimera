import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { shouldConfirmUltraSwitch, ultraSwitchCopy } from "@tui/util/variant"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  const { theme } = useTheme()

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: async () => {
          const prev = local.model.variant.current()
          if (shouldConfirmUltraSwitch(prev, undefined)) {
            const copy = ultraSwitchCopy(prev, undefined)
            const ok = await DialogConfirm.show(dialog, copy.title, copy.message)
            if (!ok) return
          }
          dialog.clear()
          local.model.variant.set(undefined)
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: variant,
        fg: variant.toLowerCase() === "ultra" ? theme.textMuted : undefined,
        onSelect: async () => {
          const prev = local.model.variant.current()
          if (shouldConfirmUltraSwitch(prev, variant)) {
            const copy = ultraSwitchCopy(prev, variant)
            const ok = await DialogConfirm.show(dialog, copy.title, copy.message)
            if (!ok) return
          }
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
