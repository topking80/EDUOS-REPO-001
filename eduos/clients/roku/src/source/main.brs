' EduOS Roku channel entry point. Everything the person sees is SceneGraph
' (components/MainScene); this only opens the screen and keeps it alive.
sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    screen.CreateScene("MainScene")
    screen.Show()
    if args <> invalid and args.contentId <> invalid
        print "EduOS: deep links aren't used; launched with contentId "; args.contentId
    end if
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.IsScreenClosed()
            return
        end if
    end while
end sub
