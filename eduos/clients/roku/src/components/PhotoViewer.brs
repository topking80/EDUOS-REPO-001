sub init()
    m.poster = m.top.findNode("poster")
    m.status = m.top.findNode("status")
    m.caption = m.top.findNode("caption")
    m.count = m.top.findNode("count")
    m.poster.ObserveField("loadStatus", "onLoadStatus")
    m.index = 0
end sub

sub onOpen()
    m.index = m.top.start
    showPhoto()
end sub

sub showPhoto()
    photos = m.top.photos
    if photos = invalid or photos.Count() = 0 then return
    if m.index < 0 then m.index = photos.Count() - 1
    if m.index >= photos.Count() then m.index = 0
    p = photos[m.index]
    m.poster.uri = ""
    m.status.text = "Loading..."
    text = Str2(p.caption)
    if text = "" then text = Str2(p.alt)
    m.caption.text = text
    m.count.text = (m.index + 1).ToStr() + " of " + photos.Count().ToStr()
    ApiCancelAll()
    ApiCall({ method: "GET", path: "/api/history/photos/" + Str2(p.id) + "?format=json" }, onLink, Str2(p.id))
end sub

sub onLink(res as object, tag as string)
    current = m.top.photos[m.index]
    if current = invalid or Str2(current.id) <> tag then return
    link = ""
    if res.status = 200 and type(res.data) = "roAssociativeArray" and type(res.data.data) = "roAssociativeArray"
        link = Str2(res.data.data.url)
    end if
    if link = ""
        m.status.text = "This photo isn't available right now."
        if res.status = 404 then m.status.text = "This photo isn't shared with you any more."
        if res.status = 0 then m.status.text = "Couldn't reach the server for this photo."
        return
    end if
    if Left(link, 1) = "/" then link = RegRead("server") + link
    m.poster.uri = link
end sub

sub onLoadStatus()
    s = m.poster.loadStatus
    if s = "ready"
        m.status.text = ""
    else if s = "failed"
        m.status.text = "Couldn't show this photo."
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    m.global.activityAt = CreateObject("roDateTime").AsSeconds()
    if key = "right"
        m.index = m.index + 1
        showPhoto()
    else if key = "left"
        m.index = m.index - 1
        showPhoto()
    else if key = "back"
        ApiCancelAll()
        m.poster.uri = ""
        m.top.closed = true
    end if
    return true
end function
