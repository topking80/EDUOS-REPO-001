// Pure status mapping shared by route tests and the authenticated reconciliation API.
export function reconcileTransportArrival({checkinEvent,handoffCount=0,handoffStatus=null,attendanceRecorded=false}) {
  if(handoffCount>1) return 'duplicate_arrival';
  if(checkinEvent==='not_riding') return 'not_riding';
  if(!checkinEvent) return 'missing_route_checkin';
  if(checkinEvent==='boarded') return 'on_route';
  if(!handoffCount) return 'missing_school_handoff';
  if(handoffStatus==='pending') return 'awaiting_school_receipt';
  if(handoffStatus==='received'&&!attendanceRecorded) return 'missing_first_attendance';
  if(handoffStatus==='received'&&attendanceRecorded) return 'complete';
  return 'review_required';
}
