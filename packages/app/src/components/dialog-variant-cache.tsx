import { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function DialogVariantCache(props: { title: string; description: string; onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog
      title={props.title}
      description={props.description}
      action={
        <div class="flex gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              props.onConfirm()
              dialog.close()
            }}
          >
            {language.t("dialog.variant.ultra.confirm")}
          </Button>
        </div>
      }
    />
  )
}
