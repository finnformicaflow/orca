import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { agentLabel, type AgentProvider } from "../../../shared/agent";
import { modelChoices, modelLabel } from "../../../shared/models";
import { useAgentProviders } from "../store";

// ONE picker for the card, the follow-up composer and the New-draft box: a model, not a provider —
// the model implies which CLI runs it (shared/models.ts). The trigger shows the model the next run
// will use; `ran` (the last run's reported model) is surfaced in the tooltip when it differs, so you
// can see what actually answered without a second readout. `quiet` = the card's hover-reveal look.
export function ModelPicker({ value, onChange, label, ran, quiet, className = "" }: {
  value: string; onChange: (id: string) => void; label: string; ran?: string; quiet?: boolean; className?: string;
}) {
  const providers = useAgentProviders();
  const choices = modelChoices(providers);
  const current = modelLabel(value);
  const title = ran && !current.endsWith(ran) ? `Next run: ${current} · last run: ${ran}` : undefined;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        title={title}
        onClick={(e) => e.stopPropagation()}
        className={quiet
          ? `text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground -ml-1 -mr-2 h-auto w-fit gap-0.5 border-transparent bg-transparent pl-2 py-0 shadow-none focus-visible:ring-0 [&>svg]:size-3 [&>svg]:opacity-0 [&>svg]:transition-opacity hover:[&>svg]:opacity-70 data-[state=open]:[&>svg]:opacity-70 ${className}`
          : `text-muted-foreground hover:bg-accent hover:text-foreground min-w-0 border-0 shadow-none transition-colors focus-visible:ring-0 ${className}`}
      >
        {current}
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        {choices.map((m) => <SelectItem key={m.id} value={m.id}>{agentLabel(m.provider as AgentProvider)} · {m.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
