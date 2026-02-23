import type { Call } from './Call';
import type { FieldDefinition, WorkflowStep, WorkflowCondition } from './types/index';

// ─── Condition Evaluation ─────────────────────────────────────────────────────

function evaluateCondition(condition: WorkflowCondition, data: Record<string, string>): boolean {
  if ('equals' in condition) {
    return data[condition.field] === condition.equals;
  } else if ('notEquals' in condition) {
    return data[condition.field] !== condition.notEquals;
  } else {
    // 'in' condition
    return (condition as { field: string; in: string[] }).in.includes(data[condition.field] ?? '');
  }
}

// ─── WorkflowExecutor ─────────────────────────────────────────────────────────

export class WorkflowExecutor {
  private call:       Call;
  private stepStack:  WorkflowStep[][];
  private indexStack: number[];

  constructor(call: Call) {
    this.call       = call;
    this.stepStack  = [call.config.workflow];
    this.indexStack = [0];
  }

  // ── Stack mechanics ──────────────────────────────────────────────────────────

  // Peek at the current step; pops exhausted levels before returning.
  getCurrentStep(): WorkflowStep | null {
    while (this.stepStack.length > 0) {
      const top = this.stepStack[this.stepStack.length - 1];
      const idx = this.indexStack[this.indexStack.length - 1];
      if (idx < top.length) return top[idx];
      // This level is exhausted — pop it.
      this.stepStack.pop();
      this.indexStack.pop();
    }
    return null;
  }

  private advance(): void {
    if (this.indexStack.length > 0) {
      this.indexStack[this.indexStack.length - 1]++;
    }
  }

  private enterBranch(steps: WorkflowStep[]): void {
    this.stepStack.push(steps);
    this.indexStack.push(0);
  }

  // ── Field collection helpers ──────────────────────────────────────────────────

  // Recursively collect ALL FieldDefinitions from collect steps (both branch paths).
  getAllFields(steps?: WorkflowStep[]): FieldDefinition[] {
    const allSteps = steps ?? this.call.config.workflow;
    const fields: FieldDefinition[] = [];
    for (const step of allSteps) {
      if (step.type === 'collect') {
        fields.push(step.field);
      } else if (step.type === 'branch') {
        fields.push(...this.getAllFields(step.then));
        if (step.else) fields.push(...this.getAllFields(step.else));
      }
    }
    return fields;
  }

  // Collect FieldDefinitions following only the active branch path for given data.
  getActiveFields(data: Record<string, string>, steps?: WorkflowStep[]): FieldDefinition[] {
    const allSteps = steps ?? this.call.config.workflow;
    const fields: FieldDefinition[] = [];
    for (const step of allSteps) {
      if (step.type === 'collect') {
        fields.push(step.field);
      } else if (step.type === 'branch') {
        if (evaluateCondition(step.condition, data)) {
          fields.push(...this.getActiveFields(data, step.then));
        } else if (step.else) {
          fields.push(...this.getActiveFields(data, step.else));
        }
      }
    }
    return fields;
  }

  // Extract conditional rules from branch steps for system prompt generation.
  getConditionalRules(steps?: WorkflowStep[]): Array<{ field: FieldDefinition; condition: WorkflowCondition }> {
    const allSteps = steps ?? this.call.config.workflow;
    const rules: Array<{ field: FieldDefinition; condition: WorkflowCondition }> = [];
    for (const step of allSteps) {
      if (step.type === 'branch') {
        for (const thenStep of step.then) {
          if (thenStep.type === 'collect') {
            rules.push({ field: thenStep.field, condition: step.condition });
          }
        }
        rules.push(...this.getConditionalRules(step.then));
        if (step.else) rules.push(...this.getConditionalRules(step.else));
      }
    }
    return rules;
  }

  // ── Prompt helpers ────────────────────────────────────────────────────────────

  // Return the first say step's text as the greeting (for chat history seeding).
  getGreeting(): string | null {
    for (const step of this.call.config.workflow) {
      if (step.type === 'say') return step.text;
    }
    return null;
  }

  // Return LLM injection string for the current collect/llm step.
  getStepContext(): string {
    const step = this.getCurrentStep();
    if (!step) return '';
    if (step.type === 'collect') {
      return `[CURRENT STEP] Now collecting: ${step.field.label} (key: ${step.field.key})`;
    }
    if (step.type === 'llm') {
      return `[CURRENT STEP] ${step.systemPrompt}`;
    }
    return '';
  }

  // ── Turn advancement ──────────────────────────────────────────────────────────

  // Called after each LLM turn. Advances collect step if field was collected;
  // advances llm step unconditionally.
  afterTurn(data: Record<string, string>): void {
    const step = this.getCurrentStep();
    if (!step) return;
    if (step.type === 'collect') {
      if (data[step.field.key]) this.advance();
    } else if (step.type === 'llm') {
      this.advance();
    }
  }

  // Advance state through branch/book steps without firing any TTS.
  // Called inside processBrainResponse (after field extraction) so that
  // workflowReadyToBook is set on the same turn the last field is collected,
  // before the drive-toward-confirmation check runs.
  advanceStateOnly(data: Record<string, string>): void {
    while (true) {
      const step = this.getCurrentStep();
      if (!step) return;
      switch (step.type) {
        case 'branch': {
          const branchSteps = evaluateCondition(step.condition, data) ? step.then : (step.else ?? []);
          this.advance();
          if (branchSteps.length > 0) this.enterBranch(branchSteps);
          break; // continue loop
        }
        case 'book': {
          if (this.call.hasScheduledAppointment) {
            this.advance();
            break; // continue — may reach hangup/transfer
          }
          this.call.workflowReadyToBook = true;
          return;
        }
        default:
          return; // stop at say/collect/llm/transfer/hangup
      }
    }
  }

  // ── Immediate step execution ──────────────────────────────────────────────────

  // Process say/branch/book/transfer/hangup steps synchronously until hitting
  // collect/llm or end. Returns the reason for stopping.
  async runImmediateSteps(data: Record<string, string>): Promise<'waiting' | 'transfer' | 'hangup' | 'done'> {
    while (true) {
      const step = this.getCurrentStep();
      if (!step) return 'done';

      switch (step.type) {
        case 'say': {
          const stream = this.call.voices.setupGoogleTTSStream();
          stream.write({ input: { text: step.text } });
          stream.end();
          this.advance();
          break;
        }

        case 'branch': {
          const takeThen  = evaluateCondition(step.condition, data);
          const branchSteps = takeThen ? step.then : (step.else ?? []);
          this.advance(); // advance past the branch step itself
          if (branchSteps.length > 0) this.enterBranch(branchSteps);
          break; // continue loop into branch
        }

        case 'book': {
          if (this.call.hasScheduledAppointment) {
            this.advance();
            break; // continue to next step (hangup/transfer)
          }
          this.call.workflowReadyToBook = true;
          return 'waiting';
        }

        case 'transfer': {
          if (step.sayBefore) {
            const stream = this.call.voices.setupGoogleTTSStream();
            stream.write({ input: { text: step.sayBefore } });
            stream.end();
          }
          if (step.number) this.call.transferTarget = step.number;
          this.call.isTransferring = true;
          this.advance();
          return 'transfer';
        }

        case 'hangup': {
          if (step.sayBefore) {
            const stream = this.call.voices.setupGoogleTTSStream();
            stream.write({ input: { text: step.sayBefore } });
            stream.end();
          }
          this.call.shouldHangup = true;
          this.advance();
          return 'hangup';
        }

        case 'collect':
        case 'llm':
          return 'waiting';
      }
    }
  }
}

export default WorkflowExecutor;
