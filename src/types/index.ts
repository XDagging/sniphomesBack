// ─── Validation Rules ────────────────────────────────────────────────────────

export type ValidationRule =
  | { type: 'email';     message: string }
  | { type: 'noSymbols'; message: string }
  | { type: 'phone';     message: string }
  | { type: 'regex';     pattern: string; message: string }
  | { type: 'minLength'; value: number;   message: string }
  | { type: 'maxLength'; value: number;   message: string };

// ─── Field Definition ────────────────────────────────────────────────────────

export interface FieldDefinition {
  key:               string;
  label:             string;
  description:       string;
  type:              'text' | 'enum' | 'appointment_time';
  enumValues?:       string[];
  enumDescriptions?: Record<string, string>;
  validations?:      ValidationRule[];
  spellOut:          boolean;
  required:          boolean;
}

// ─── Workflow Types ───────────────────────────────────────────────────────────

export type WorkflowCondition =
  | { field: string; equals: string }
  | { field: string; notEquals: string }
  | { field: string; in: string[] };

export type SayStep      = { type: 'say';      text: string };
export type CollectStep  = { type: 'collect';  field: FieldDefinition };
export type LLMStep      = { type: 'llm';      systemPrompt: string };
export type BranchStep   = { type: 'branch';   condition: WorkflowCondition; then: WorkflowStep[]; else?: WorkflowStep[] };
export type BookStep     = { type: 'book' };
export type TransferStep = { type: 'transfer'; number?: string; sayBefore?: string };
export type HangupStep   = { type: 'hangup';   sayBefore?: string };

export type WorkflowStep =
  | SayStep | CollectStep | LLMStep | BranchStep
  | BookStep | TransferStep | HangupStep;

// ─── Booking Config ───────────────────────────────────────────────────────────

export interface CalendlyBookingConfig {
  provider:          'calendly';
  eventName:         string;
  speakBeforeAction: boolean;
  inviteeFieldMapping: {
    email:  string;
    name:   string;
    phone?: string;
  };
  questionMapping: Array<{
    question: string;
    fieldKey: string;
    position: number;
    default?: string;
  }>;
}

export interface EmailBookingConfig {
  provider:          'email';
  speakBeforeAction: boolean;
  recipientEmail:    string;
  fieldMapping: {
    name:           string;
    phone:          string;
    jobDescription: string;
    address?:       string;
  };
}

export type BookingConfig = CalendlyBookingConfig | EmailBookingConfig;

// ─── Agent Config ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  // Identity
  agentName:           string;
  businessName:        string;
  businessDescription: string;
  businessLocation:    string;
  businessHours:       string;
  landmarks?:          string;
  services:            string[];
  pricingPolicy?:      string;
  additionalRules?:    string[];

  // Call behavior
  transferNumber: string;
  timezone?:      string;

  // AI / voice
  geminiModel?: string;
  ttsVoice?:    string;

  // Workflow
  workflow: WorkflowStep[];

  // Booking (optional — omit if no external booking needed)
  booking?: BookingConfig;
}

// ─── Calendly payload (internal) ─────────────────────────────────────────────

export interface CalendlySchedulePayload {
  email:            string;
  name:             string;
  phone:            string;
  appointmentTime:  string;
  questionsAndAnswers: Array<{
    question: string;
    answer:   string;
    position: number;
  }>;
}

export interface ToolConfig {
  provider:          string;
  speakBeforeAction: boolean;
}

// ─── Example Configs ─────────────────────────────────────────────────────────

// ── Quattro Autobody field definitions ────────────────────────────────────────

const customerName: FieldDefinition = {
  key:         'customerName',
  label:       'your name',
  description: "The customer's proper name (first, last, or both). NEVER extract pronouns, generic words, or phrases like 'myself', 'me', 'I', 'us', 'the customer'. If the user has not clearly stated their name, omit this field and ask.",
  type:        'text',
  required:    true,
  spellOut:    false,
};

const vehicleModel: FieldDefinition = {
  key:         'vehicleModel',
  label:       'your vehicle year, make, and model',
  description: 'The vehicle year/make/model.',
  type:        'text',
  required:    true,
  spellOut:    false,
};

const customerEmail: FieldDefinition = {
  key:         'customerEmail',
  label:       'your email address',
  description: "The customer's email. RECONSTRUCT spoken emails: 'john dot doe at gmail' -> 'john.doe@gmail.com'.",
  type:        'text',
  required:    true,
  validations: [{ type: 'email', message: 'Must be a valid email address' }],
  spellOut:    true,
};

const paymentMethodAutobody: FieldDefinition = {
  key:         'paymentMethod',
  label:       'your payment method',
  description: "Payment method. STRICT MAPPING: If 'cash', 'credit', 'debit', 'myself', 'private' -> use 'out-of-pocket'. If 'State Farm', 'Geico', 'claim', 'deductible', or anything that sounds like insurance -> use 'insurance'. If the user is confused, give them the option of insurance or paying out of pocket.",
  type:        'enum',
  enumValues:  ['insurance', 'out-of-pocket'],
  required:    true,
  spellOut:    false,
};

const appointmentTimeField: FieldDefinition = {
  key:         'appointmentTime',
  label:       'appointment time',
  description: "The exact UTC ISO string from the bracketed portion of the available slots list — copy it character-for-character (e.g. '2026-02-22T18:00:00.000Z'). ONLY include when the user has explicitly chosen a specific slot from the list this turn. Do NOT generate, retype, or infer a time — copy the bracket string exactly.",
  type:        'appointment_time',
  required:    true,
  spellOut:    false,
};

export const QUATTRO_AUTOBODY_CONFIG: AgentConfig = {
  agentName:           'John',
  businessName:        'Snip Homes Autobody',
  businessDescription: 'Book estimates for collision repair',
  businessLocation:    '4907 Elm St, Bethesda, MD 20814',
  businessHours:       '8am-4pm, M-F',
  landmarks:           'Across from a Matchbox Restaurant, a public parking lot is in front of it, and under an Equinox Gym',
  services:            ['Collision', 'paint', 'dents (PDR)', 'frame work'],
  pricingPolicy:       'No phone quotes. "Come in for a free estimate."',
  additionalRules:     ['APPOINTMENTS: 30-min slots. Hour or half-hour only.'],
  transferNumber:      '301-272-7224',
  timezone:            'America/New_York',
  geminiModel:         'gemini-2.5-flash-lite',
  ttsVoice:            'en-US-Chirp3-HD-Puck',

  workflow: [
    { type: 'say', text: 'Hi, this is John at Snip Homes Autobody! How can I help you today?' },
    { type: 'collect', field: customerName },
    { type: 'collect', field: vehicleModel },
    { type: 'collect', field: customerEmail },
    { type: 'collect', field: paymentMethodAutobody },
    { type: 'collect', field: appointmentTimeField },
    { type: 'book' },
    { type: 'hangup', sayBefore: 'Perfect! Your estimate appointment is all set. We look forward to seeing you!' },
  ],

  booking: {
    speakBeforeAction: false,
    provider:          'calendly',
    eventName:         'Quattro Autobody',
    inviteeFieldMapping: {
      email: 'customerEmail',
      name:  'customerName',
    },
    questionMapping: [
      { question: 'Model',           fieldKey: 'vehicleModel',  position: 0 },
      { question: 'Make',            fieldKey: 'vehicleModel',  position: 1, default: 'N/A' },
      { question: 'Insurance Claim', fieldKey: 'paymentMethod', position: 2 },
    ],
  },
};

// ── Dental Clinic field definitions ───────────────────────────────────────────

const patientName: FieldDefinition = {
  key:         'patientName',
  label:       'your name',
  description: "The patient's full name.",
  type:        'text',
  required:    true,
  spellOut:    false,
};

const patientEmail: FieldDefinition = {
  key:         'patientEmail',
  label:       'your email address',
  description: "The patient's email address.",
  type:        'text',
  required:    true,
  validations: [{ type: 'email', message: 'Must be a valid email address' }],
  spellOut:    true,
};

const paymentMethodDental: FieldDefinition = {
  key:         'paymentMethod',
  label:       'your payment method',
  description: "Payment method: 'insurance' or 'out-of-pocket'. If the patient mentions a dental insurance plan, use 'insurance'. Otherwise use 'out-of-pocket'.",
  type:        'enum',
  enumValues:  ['insurance', 'out-of-pocket'],
  required:    true,
  spellOut:    false,
};

const insuranceProvider: FieldDefinition = {
  key:         'insuranceProvider',
  label:       'your insurance provider',
  description: "The name of the patient's dental insurance provider (e.g. Delta Dental, Cigna). Only collect if paymentMethod is 'insurance'.",
  type:        'text',
  required:    false,
  spellOut:    false,
};

const dentalAppointmentTime: FieldDefinition = {
  key:         'appointmentTime',
  label:       'appointment time',
  description: "The exact UTC ISO string from the bracketed portion of the available slots list — copy it character-for-character. ONLY include when the user has explicitly chosen a specific slot this turn.",
  type:        'appointment_time',
  required:    true,
  spellOut:    false,
};

export const DENTAL_CLINIC_CONFIG: AgentConfig = {
  agentName:           'Maya',
  businessName:        'Bright Smile Dental',
  businessDescription: 'Book dental appointments for new and existing patients',
  businessLocation:    '123 Main St, Rockville, MD 20850',
  businessHours:       '9am-5pm, M-F',
  services:            ['Cleanings', 'X-rays', 'Fillings', 'Root canals', 'Whitening'],
  pricingPolicy:       'Pricing varies. Call for a free consultation.',
  transferNumber:      '301-555-0100',
  timezone:            'America/New_York',

  workflow: [
    { type: 'say', text: 'Hi, this is Maya at Bright Smile Dental! How can I help you today?' },
    { type: 'collect', field: patientName },
    { type: 'collect', field: patientEmail },
    { type: 'collect', field: paymentMethodDental },
    { type: 'branch', condition: { field: 'paymentMethod', equals: 'insurance' }, then: [
      { type: 'collect', field: insuranceProvider },
    ]},
    { type: 'collect', field: dentalAppointmentTime },
    { type: 'book' },
    { type: 'hangup' },
  ],
};

// ── S and M Powerwashing field definitions ────────────────────────────────────

const powerwashingCustomerName: FieldDefinition = {
  key:         'customerName',
  label:       'your name',
  description: "The customer's full name (first, last, or both). NEVER extract pronouns or generic words like 'myself', 'me', 'I'. If not clearly stated, omit and ask.",
  type:        'text',
  required:    true,
  spellOut:    false,
};

const powerwashingCustomerPhone: FieldDefinition = {
  key:         'customerPhone',
  label:       'your phone number',
  description: "The customer's callback phone number. Reconstruct spoken numbers as digits (e.g. 'three oh one' -> '301').",
  type:        'text',
  required:    true,
  spellOut:    true,
  validations: [{ type: 'phone', message: 'Must be a valid phone number (digits, spaces, dashes, parentheses)' }],
};

const powerwashingJobDescription: FieldDefinition = {
  key:         'jobDescription',
  label:       'a brief description of what you need done',
  description: "A short description of the powerwashing job (e.g. 'driveway and front walkway', 'house exterior', 'deck and patio'). Capture what the customer says naturally.",
  type:        'text',
  required:    true,
  spellOut:    false,
};

const powerwashingAddress: FieldDefinition = {
  key:         'address',
  label:       'the address of the property',
  description: "The service address. Optional — if the customer says they will provide it later or declines, do not force it. Capture street, city, and state if given.",
  type:        'text',
  required:    false,
  spellOut:    false,
};


const S_and_M_agent_name = "Alex"

export const S_AND_M_POWERWASHING_CONFIG: AgentConfig = {
  agentName:           S_and_M_agent_name,
  businessName:        'S and M Powerwashing',
  businessDescription: 'Collect customer information and job details for powerwashing service bookings',
  businessLocation:    'Serving the local area',
  businessHours:       '8am-6pm, Mon-Sat',
  services:            ['House exterior washing', 'Driveway cleaning', 'Deck and patio washing', 'Sidewalk cleaning', 'Fence washing', 'Roof soft washing'],
  pricingPolicy:       'Pricing depends on the job. A team member will follow up with a quote after you submit your request.',
  additionalRules:     [
    'Address is optional but strongly encouraged so we can provide an accurate quote.',
    'Let the customer know someone from the team will reach out to confirm details and schedule a time.',
  ],
  transferNumber:      '301-272-7224',
  timezone:            'America/New_York',
  geminiModel:         'gemini-2.5-flash-lite',
  ttsVoice:            'en-US-Chirp3-HD-Puck',

  workflow: [
    { type: 'say', text: `Hi, thank you for calling S and M Powerwashing! I'm ${S_and_M_agent_name}, how can I help you today?` },
    { type: 'collect', field: powerwashingCustomerName },
    { type: 'collect', field: powerwashingCustomerPhone },
    { type: 'collect', field: powerwashingJobDescription },
    // { type: 'collect', field: powerwashingAddress },
    { type: 'book' },
    { type: 'hangup', sayBefore: "Perfect! We've got your request. Someone from our team will reach out soon to confirm the details and get you scheduled. Have a great day!" },
  ],

  booking: {
    provider:          'email',
    speakBeforeAction: false,
    recipientEmail:    process.env.BOOKING_RECIPIENT_EMAIL ?? '',
    fieldMapping: {
      name:           'customerName',
      phone:          'customerPhone',
      jobDescription: 'jobDescription',
      // address:        'address',
    },
  },
};
