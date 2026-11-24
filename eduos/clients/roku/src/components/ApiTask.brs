sub init()
    m.top.functionName = "doRequest"
end sub

sub doRequest()
    req = m.top.request
    server = RegRead("server")
    if server = ""
        m.top.response = { status: 0, data: invalid, error: "no_server" }
        return
    end if
    method = UCase(Str2(req.method, "GET"))

    http = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    http.SetMessagePort(port)
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.RetainBodyOnError(true)
    http.EnableEncodings(true)
    http.SetUrl(server + req.path)
    http.AddHeader("Accept", "application/json")
    token = RegRead("token")
    withSession = true
    if type(req.auth) = "Boolean" or type(req.auth) = "roBoolean" then withSession = req.auth
    if withSession and token <> ""
        ' Bearer, never a cookie (the same as the phone app).
        http.AddHeader("Authorization", "Bearer " + token)
        if method <> "GET" then http.AddHeader("X-CSRF-Token", RegRead("csrf"))
    end if

    started = false
    if method = "GET"
        started = http.AsyncGetToString()
    else
        http.SetRequest(method)
        http.AddHeader("Content-Type", "application/json")
        body = "{}"
        if req.body <> invalid then body = FormatJson(req.body)
        started = http.AsyncPostFromString(body)
    end if
    if not started
        m.top.response = { status: 0, data: invalid, error: "network" }
        return
    end if

    msg = wait(30000, port)
    if type(msg) <> "roUrlEvent"
        http.AsyncCancel()
        m.top.response = { status: 0, data: invalid, error: "timeout" }
        return
    end if
    status = msg.GetResponseCode()
    data = invalid
    text = msg.GetString()
    if text <> invalid and text <> "" then data = ParseJson(text)
    errorCode = ""
    if status < 200 or status >= 300
        errorCode = "http_" + status.ToStr()
        if status <= 0 then errorCode = "network"
        if type(data) = "roAssociativeArray" and data.error <> invalid then errorCode = Str2(data.error, errorCode)
    end if
    m.top.response = { status: status, data: data, error: errorCode }
end sub
