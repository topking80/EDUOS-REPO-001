sub init()
    m.top.ObserveField("active", "onActive")
    m.message = m.top.findNode("message")
    m.pin = m.top.findNode("pin")
    m.pin.ObserveField("done", "onPin")
    m.wait = m.top.findNode("wait")
    m.wait.ObserveField("fire", "onWaitTick")
    m.buttons = m.top.findNode("buttons")
    m.buttons.buttons = ["Sign this TV out"]
    m.buttons.ObserveField("buttonSelected", "onSignOut")
end sub

' Signing out shows nothing, so it needs no PIN: the next person signs in with a new code.
sub onSignOut()
    ApiCall({ method: "POST", path: "/auth/logout" }, onSignedOut)
end sub

sub onSignedOut(res as object, tag as string)
    print "EduOS: sign-out "; tag; " "; res.status
    ForgetSession()
    m.top.outcome = { go: "pair", note: "This TV is signed out." }
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press or key <> "back" then return false
    if m.buttons.hasFocus()
        if m.pin.visible then m.pin.setFocus(true)
    else
        m.buttons.setFocus(true)
    end if
    return true
end function

sub onActive()
    if not m.top.active
        m.wait.control = "stop"
        ApiCancelAll()
        return
    end if
    parts = RegRead("pin").Split("|")
    m.pin.length = 4
    if parts.Count() = 3 then m.pin.length = IntOf(parts[2])
    m.pin.reset = true
    m.note = m.top.note
    refresh()
end sub

sub refresh()
    remaining = PinWaitSeconds()
    if remaining > 0
        m.message.text = "Too many wrong PINs. Try again in " + remaining.ToStr() + " seconds."
        m.pin.visible = false
        m.wait.control = "start"
        m.buttons.setFocus(true)
        return
    end if
    m.wait.control = "stop"
    m.pin.visible = true
    m.message.text = "Enter the screen-lock PIN."
    if m.note <> "" then m.message.text = m.note + " Enter the screen-lock PIN."
    m.pin.setFocus(true)
end sub

sub onWaitTick()
    if PinWaitSeconds() <= 0
        refresh()
    else
        m.message.text = "Too many wrong PINs. Try again in " + PinWaitSeconds().ToStr() + " seconds."
    end if
end sub

sub onPin()
    if PinWaitSeconds() > 0
        refresh()
        return
    end if
    if PinMatches(m.pin.done)
        NotePinSuccess()
        m.top.outcome = { go: "home", note: "" }
        return
    end if
    NotePinFailure()
    m.note = "That PIN isn't right."
    refresh()
end sub
