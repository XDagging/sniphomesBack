import 'dotenv/config';
import type { CalendlySchedulePayload } from './types/index';

let cachedEventType = '';

async function getCurrentUser(): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.calendly.com/users/me', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
    },
  });
  console.log('Calendly /users/me status', response.status);
  return response.json() as Promise<Record<string, unknown>>;
}

async function getEventTypes(organizationId: string): Promise<Record<string, unknown>> {
  console.log('org id', organizationId);
  const response = await fetch(
    `https://api.calendly.com/event_types?count=99&organization=${organizationId}&active=true`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
      },
    },
  );
  console.log('getEventTypes status', response.status);
  return response.json() as Promise<Record<string, unknown>>;
}

async function getEventAvailability(
  _userUri: string,
  eventTypeUri: string,
  startDate: string,
): Promise<Record<string, unknown>> {
  const start = new Date(startDate);
  const end   = new Date(start);
  end.setDate(end.getDate() + 7);

  const params = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: start.toISOString(),
    end_time:   end.toISOString(),
  });

  console.log('Fetching availability for:', params.toString());

  const response = await fetch(
    `https://api.calendly.com/event_type_available_times?${params}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
      },
    },
  );

  console.log('getEventAvailability status:', response.status);
  if (response.status !== 200) {
    const text = await response.text();
    console.log('Error body:', text);
    throw new Error(`Calendly availability error: ${response.status}`);
  }

  const data = (await response.json()) as { collection?: Array<{ status: string; start_time: string }> };
  if (data.collection) {
    data.collection = data.collection.filter(slot => slot.status === 'available');
  }
  return data as unknown as Record<string, unknown>;
}

export async function scheduleAppointment(payload: CalendlySchedulePayload): Promise<Record<string, unknown>> {
  try {
    const { email, name, phone, appointmentTime, questionsAndAnswers } = payload;
    const EVENT_TYPE_URI = cachedEventType;

    const body = {
      event_type: EVENT_TYPE_URI,
      start_time: appointmentTime,
      invitee: {
        email,
        name,
        timezone: 'America/New_York',
        text_reminder_number: phone,
      },
      questions_and_answers: questionsAndAnswers.map(q => ({
        question: q.question,
        answer:   q.answer,
        position: q.position,
      })),
    };

    console.log('Sending payload to Calendly:', JSON.stringify(body, null, 2));

    const response = await fetch('https://api.calendly.com/invitees', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as Record<string, unknown>;
      console.error('Calendly API Error:', JSON.stringify(errorData, null, 2));
      throw new Error(JSON.stringify(errorData));
    }

    return response.json() as Promise<Record<string, unknown>>;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.log('Error creating scheduled event:', e);
    return { error: msg };
  }
}

export async function getAvailability(startDate: string, eventName: string): Promise<string[]> {
  console.log('getAvailability startDate:', startDate, 'eventName:', eventName);

  const user           = await getCurrentUser();
  const userResource   = (user as { resource: { uri: string; current_organization: string } }).resource;
  const userUri        = userResource.uri;
  const organizationUrl = userResource.current_organization;

  const clientSchedules = await getEventTypes(organizationUrl);
  const collection = (clientSchedules as { collection: Array<{ name: string; uri: string }> }).collection;

  const targetEvent = collection.find(event => event.name === eventName);
  console.log('target event', targetEvent);
  if (!targetEvent) {
    console.log('Event type not found:', eventName);
    return [];
  }

  const eventTypeUri   = targetEvent.uri;
  cachedEventType      = eventTypeUri;

  const availability = await getEventAvailability(userUri, eventTypeUri, startDate);
  const slots = (availability as { collection: Array<{ start_time: string }> }).collection;

  return slots.map(slot => slot.start_time);
}
