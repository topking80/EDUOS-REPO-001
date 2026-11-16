// Pure grouping helper for the batched transport manifest query.
// Keys include both run and student because a student can ride different runs.
export function groupTransportEvents(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.run_id}:${event.student_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      event: event.event,
      recorded_at: event.recorded_at,
      stop_name: event.stop_name,
      is_school: event.is_school
    });
  }
  return grouped;
}
