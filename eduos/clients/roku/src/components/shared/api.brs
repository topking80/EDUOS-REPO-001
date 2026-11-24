' Start an ApiTask; `handler` (a function in this component) is called with
' (response as object, tag as string) when it finishes. Calling it through a
' local variable keeps `m` as this component's m.
sub ApiCall(req as object, handler as function, tag = "" as string)
    if m.apiTasks = invalid then m.apiTasks = {}
    if m.apiSeq = invalid then m.apiSeq = 0
    m.apiSeq = m.apiSeq + 1
    key = "api" + m.apiSeq.ToStr()
    task = CreateObject("roSGNode", "ApiTask")
    task.id = key
    task.request = req
    task.ObserveField("response", "ApiDone")
    m.apiTasks[key] = { task: task, handler: handler, tag: tag }
    task.control = "RUN"
end sub

sub ApiDone(event as object)
    key = event.GetRoSGNode().id
    entry = m.apiTasks[key]
    if entry = invalid then return
    m.apiTasks.Delete(key)
    handler = entry.handler
    handler(event.GetData(), entry.tag)
end sub

' Forget every request still running (their answers are ignored).
sub ApiCancelAll()
    if m.apiTasks = invalid then return
    for each key in m.apiTasks
        m.apiTasks[key].task.control = "STOP"
    end for
    m.apiTasks = {}
end sub
