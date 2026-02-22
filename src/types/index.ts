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
  required:          boolean;
  condition?: {
    field:  string;
    equals: string;
  };
}

// ─── Booking Config ───────────────────────────────────────────────────────────

export interface CalendlyBookingConfig {
  provider:     'calendly';
  eventName:    string;
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

export interface NoBookingConfig { provider: 'none'; }

export type BookingConfig = CalendlyBookingConfig | NoBookingConfig;

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
  greeting?:      string;
  timezone?:      string;

  // AI / voice
  geminiModel?: string;
  ttsVoice?:    string;

  // Data collection schema
  fields: FieldDefinition[];

  // Booking
  booking: BookingConfig;
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

// ─── Example Configs ─────────────────────────────────────────────────────────

export const QUATTRO_AUTOBODY_CONFIG: AgentConfig = {
  agentName:           'Carlos',
  businessName:        'Quattro Autobody',
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

  fields: [
    {
      key:         'customerName',
      label:       'your name',
      description: "The customer's proper name (first, last, or both). NEVER extract pronouns, generic words, or phrases like 'myself', 'me', 'I', 'us', 'the customer'. If the user has not clearly stated their name, omit this field and ask.",
      type:        'text',
      required:    true,
    },
    {
      key:         'vehicleModel',
      label:       'your vehicle year, make, and model',
      description: 'The vehicle year/make/model.',
      type:        'text',
      required:    true,
    },
    {
      key:         'customerEmail',
      label:       'your email address',
      description: "The customer's email. RECONSTRUCT spoken emails: 'john dot doe at gmail' -> 'john.doe@gmail.com'.",
      type:        'text',
      required:    true,
      validations: [{ type: 'email', message: 'Must be a valid email address' }],
    },
    {
      key:         'paymentMethod',
      label:       'your payment method',
      description: "Payment method. STRICT MAPPING: If 'cash', 'credit', 'debit', 'myself', 'private' -> use 'out-of-pocket'. If 'State Farm', 'Geico', 'claim', 'deductible', or anything that sounds like insurance -> use 'insurance'. If the user is confused, give them the option of insurance or paying out of pocket.",
      type:        'enum',
      enumValues:  ['insurance', 'out-of-pocket'],
      required:    true,
    },
    {
      key:         'appointmentTime',
      label:       'appointment time',
      description: "The exact UTC ISO string from the bracketed portion of the available slots list — copy it character-for-character (e.g. '2026-02-22T18:00:00.000Z'). ONLY include when the user has explicitly chosen a specific slot from the list this turn. Do NOT generate, retype, or infer a time — copy the bracket string exactly.",
      type:        'appointment_time',
      required:    true,
    },
  ],

  booking: {
    provider:  'calendly',
    eventName: 'Quattro Autobody',
    inviteeFieldMapping: {
      email: 'customerEmail',
      name:  'customerName',
    },
    questionMapping: [
      { question: 'Model',           fieldKey: 'vehicleModel',   position: 0 },
      { question: 'Make',            fieldKey: 'vehicleModel',   position: 1, default: 'N/A' },
      { question: 'Insurance Claim', fieldKey: 'paymentMethod',  position: 2 },
    ],
  },
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

  fields: [
    {
      key:         'patientName',
      label:       'your name',
      description: "The patient's full name.",
      type:        'text',
      required:    true,
    },
    {
      key:         'patientEmail',
      label:       'your email address',
      description: "The patient's email address.",
      type:        'text',
      required:    true,
      validations: [{ type: 'email', message: 'Must be a valid email address' }],
    },
    {
      key:         'paymentMethod',
      label:       'your payment method',
      description: "Payment method: 'insurance' or 'out-of-pocket'. If the patient mentions a dental insurance plan, use 'insurance'. Otherwise use 'out-of-pocket'.",
      type:        'enum',
      enumValues:  ['insurance', 'out-of-pocket'],
      required:    true,
    },
    {
      key:         'insuranceProvider',
      label:       'your insurance provider',
      description: "The name of the patient's dental insurance provider (e.g. Delta Dental, Cigna). Only collect if paymentMethod is 'insurance'.",
      type:        'text',
      required:    false,
      condition:   { field: 'paymentMethod', equals: 'insurance' },
    },
    {
      key:         'appointmentTime',
      label:       'appointment time',
      description: "The exact UTC ISO string from the bracketed portion of the available slots list — copy it character-for-character. ONLY include when the user has explicitly chosen a specific slot this turn.",
      type:        'appointment_time',
      required:    true,
    },
  ],

  booking: { provider: 'none' },
};
