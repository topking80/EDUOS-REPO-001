sub init()
    m.top.ObserveField("active", "onActive")
    m.url = m.top.findNode("url")
    m.code = m.top.findNode("code")
    m.status = m.top.findNode("status")
    m.qr = m.top.findNode("qr")
    m.buttons = m.top.findNode("buttons")
    m.buttons.buttons = ["New code", "Change district"]
    m.buttons.ObserveField("buttonSelected", "onButton")
    m.poll = m.top.findNode("poll")
    m.poll.ObserveField("fire", "onPoll")
    m.deviceCode = ""
    m.interval = 5
end sub

sub onActive()
    if not m.top.active
        m.poll.control = "stop"
        ApiCancelAll()
        return
    end if
    m.buttons.setFocus(true)
    requestCode(m.top.note)
end sub

sub requestCode(note as string)
    m.poll.control = "stop"
    m.deviceCode = ""
    m.code.text = "..."
    m.url.text = ""
    m.qr.rows = []
    m.status.text = note
    info = CreateObject("roDeviceInfo")
    label = info.GetFriendlyName()
    if label = "" then label = "Roku " + info.GetModelDisplayName()
    ApiCall({ method: "POST", path: "/auth/device/code", auth: false,
        body: { clientKind: "roku", deviceLabel: label } }, onCode)
end sub

sub onCode(res as object, tag as string)
    if res.status <> 200 or type(res.data) <> "roAssociativeArray"
        m.code.text = ""
        if res.error = "device_sign_in_disabled"
            m.status.text = "Your district hasn't turned on TV sign-in yet. Ask your school's EduOS administrator."
        else if res.status = 429
            m.status.text = "Too many new codes for now. Wait a minute, then choose New code."
        else if res.status = 0
            m.status.text = "Couldn't reach " + RegRead("server") + ". Check this TV's internet connection, then choose New code."
        else
            m.status.text = "Couldn't get a code (" + res.error + "). Choose New code to try again."
        end if
        return
    end if
    d = res.data
    m.deviceCode = Str2(d.deviceCode)
    m.code.text = Str2(d.userCode)
    m.url.text = Str2(d.verificationUri)
    if type(d.qr) = "roArray" then m.qr.rows = d.qr
    m.interval = 5
    if type(d.interval) = "roInt" or type(d.interval) = "Integer" then m.interval = d.interval
    minutes = 10
    if d.expiresIn <> invalid then minutes = Int(d.expiresIn / 60)
    if m.status.text = "" then m.status.text = "The code works for " + minutes.ToStr() + " minutes. Waiting for you to approve it..."
    schedulePoll()
    print "EduOS: code ready "; tag
end sub

sub schedulePoll()
    m.poll.duration = m.interval
    m.poll.control = "start"
end sub

sub onPoll()
    if m.deviceCode = "" then return
    ApiCall({ method: "POST", path: "/auth/device/token", auth: false, body: { deviceCode: m.deviceCode } }, onToken)
end sub

sub onToken(res as object, tag as string)
    if not m.top.active then return
    if res.status = 200 and type(res.data) = "roAssociativeArray" and Str2(res.data.sessionToken) <> ""
        d = res.data
        ForgetSession()
        RegWrite("token", Str2(d.sessionToken))
        RegWrite("csrf", Str2(d.csrfToken))
        RegWrite("role", Str2(d.role))
        RegWrite("clientKind", Str2(d.clientKind, "roku"))
        m.deviceCode = ""
        m.top.outcome = { go: "home", note: "" }
        return
    end if
    e = res.error
    if e = "authorization_pending"
        schedulePoll()
    else if e = "slow_down" or res.status = 429
        m.interval = m.interval + 5
        schedulePoll()
    else if e = "access_denied"
        m.deviceCode = ""
        m.status.text = "The sign-in was declined. Choose New code to try again."
    else if e = "expired_token" or e = "invalid_grant"
        requestCode("That code ran out, so here's a new one.")
    else if e = "account_not_active"
        m.deviceCode = ""
        m.status.text = "That EduOS account isn't active. Ask your school, then choose New code."
    else
        ' A dropped connection: keep trying at a gentler pace.
        m.interval = m.interval + 5
        if m.interval > 60 then m.interval = 60
        schedulePoll()
    end if
    print "EduOS: poll "; tag; " "; e
end sub

sub onButton()
    if m.buttons.buttonSelected = 0
        requestCode("")
    else
        m.top.outcome = { go: "setup", note: "" }
    end if
end sub
