sub init()
    m.top.ObserveField("active", "onActive")
    m.buttons = m.top.findNode("buttons")
    m.message = m.top.findNode("message")
    m.current = m.top.findNode("current")
    m.buttons.buttons = ["Enter the district address"]
    m.buttons.ObserveField("buttonSelected", "onButton")
    m.candidate = ""
end sub

sub onActive()
    if not m.top.active
        ApiCancelAll()
        return
    end if
    m.message.text = m.top.note
    saved = RegRead("server")
    m.current.text = ""
    if saved <> "" then m.current.text = "Now: " + saved
    m.buttons.setFocus(true)
end sub

sub onButton()
    dialog = CreateObject("roSGNode", "StandardKeyboardDialog")
    dialog.title = "District EduOS address"
    dialog.message = ["For example eduos.yourdistrict.org"]
    dialog.buttons = ["Continue", "Cancel"]
    dialog.text = Mid(RegRead("server"), 9)
    dialog.ObserveField("buttonSelected", "onDialogButton")
    m.dialog = dialog
    m.top.getScene().dialog = dialog
end sub

sub onDialogButton()
    pressed = m.dialog.buttonSelected
    text = m.dialog.text
    m.dialog.close = true
    m.buttons.setFocus(true)
    if pressed <> 0 then return
    origin = NormalizeServer(text)
    if origin = ""
        m.message.text = "That doesn't look like a web address. Enter something like eduos.yourdistrict.org (https only)."
        return
    end if
    m.candidate = origin
    m.message.text = "Checking " + origin + "..."
    ' Save first: ApiTask reads the address from the registry.
    m.previous = RegRead("server")
    RegWrite("server", origin)
    ApiCall({ method: "GET", path: "/health", auth: false }, onHealth)
end sub

sub onHealth(res as object, tag as string)
    if res.status = 200 and type(res.data) = "roAssociativeArray" and Str2(res.data.status) = "ok"
        if m.previous <> m.candidate then ForgetSession()
        m.top.outcome = { go: "next" }
        return
    end if
    RegWrite("server", m.previous)
    if res.status = 0
        m.message.text = "Couldn't reach " + m.candidate + ". Check the address and this TV's internet connection."
    else
        m.message.text = m.candidate + " didn't answer like an EduOS server (" + res.status.ToStr() + "). Check the address with your school."
    end if
    print "EduOS: health check "; tag; " "; res.error
end sub
