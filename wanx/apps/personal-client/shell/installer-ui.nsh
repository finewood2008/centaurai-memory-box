; Shared by standard, signed-release and internal Windows packages.
!include nsDialogs.nsh
!include FileFunc.nsh
SetFont "Microsoft YaHei UI" 9

!define MUI_BGCOLOR "FCF9F5"
!define MUI_TEXTCOLOR "302C28"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择半人马AI-记忆盒子的安装位置。应用将为当前 Windows 用户安装。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_INSTFILESPAGE_COLORS "A35D40 FCF9F5"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "半人马AI-记忆盒子已安装。首次打开后，可前往「盒子」连接设备。"
!define MUI_FINISHPAGE_RUN_TEXT "打开半人马AI-记忆盒子"
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight

!define WANX_ACM_OPEN 0x0467 ; ACM_OPENW
!define WANX_ACM_PLAY 0x0465

Var WanxWelcomeDialog
Var WanxArtwork
Var WanxBitmap
Var WanxArtParent
Var WanxArtFile
Var WanxArtTop
Var WanxArtHeight
Var WanxProgressAnimation
Var WanxLocation
Var WanxLocationError
Var WanxAcceptedLocation

!macro customWelcomePage
  Page custom WanxWelcomeShow WanxWelcomeLeave
!macroend

!macro customHeader
BrandingText " "

Function WanxPlaceArtwork
  ; $3/$5/$6 preserve the slot width, top and height for the animation control.
  StrCpy $WanxArtwork 0
  StrCpy $WanxBitmap 0
  System::Call 'user32::GetClientRect(p $WanxArtParent, @r0)'
  System::Call '*$0(i, i, i.r3, i.r4)'
  System::Call 'kernel32::MulDiv(i r4, i $WanxArtTop, i 100) i.r5'
  System::Call 'kernel32::MulDiv(i r4, i $WanxArtHeight, i 100) i.r6'
  System::Call 'kernel32::MulDiv(i r3, i 92, i 100) i.r7'

  System::Call 'user32::LoadImageW(p 0, w "$WanxArtFile", i ${IMAGE_BITMAP}, i 0, i 0, i ${LR_LOADFROMFILE}) p.r0'
  ${If} $0 P= 0
    Return
  ${EndIf}
  System::Alloc 32
  Pop $1
  System::Call 'gdi32::GetObjectW(p r0, i 32, p r1) i.r2'
  System::Call '*$1(i, i.r8, i.r9)'
  System::Free $1
  System::Call 'gdi32::DeleteObject(p r0)'
  ${If} $2 == 0
  ${OrIf} $8 <= 0
  ${OrIf} $9 <= 0
  ${OrIf} $6 <= 0
  ${OrIf} $7 <= 0
    Return
  ${EndIf}
  ; Fit the bitmap within both axes by deriving its other dimension from its ratio.
  System::Call 'kernel32::MulDiv(i r7, i r9, i r8) i.r4'
  ${If} $4 > $6
    StrCpy $4 $6
    System::Call 'kernel32::MulDiv(i r4, i r8, i r9) i.r7'
  ${EndIf}
  IntOp $0 $3 - $7
  IntOp $0 $0 / 2
  IntOp $1 $6 - $4
  IntOp $1 $1 / 2
  IntOp $1 $1 + $5
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000004E, i r0, i r1, i r7, i r4, p $WanxArtParent, p 0, p 0, p 0) p.s'
  Pop $WanxArtwork
  ${If} $WanxArtwork P<> 0
    ${NSD_SetStretchedImage} $WanxArtwork "$WanxArtFile" $WanxBitmap
  ${EndIf}
FunctionEnd

Function WanxWelcomeShow
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\memobox-overview.bmp" "${PROJECT_DIR}\resources\installer\illustrated\windows-overview.bmp"
  nsDialogs::Create 1044
  Pop $WanxWelcomeDialog
  ${If} $WanxWelcomeDialog == error
    SetErrorLevel 1603
    Quit
  ${EndIf}
  SetCtlColors $WanxWelcomeDialog 302C28 FCF9F5

  StrCpy $WanxArtParent $WanxWelcomeDialog
  StrCpy $WanxArtTop 4
  StrCpy $WanxArtHeight 64
  StrCpy $WanxArtFile "$PLUGINSDIR\memobox-overview.bmp"
  Call WanxPlaceArtwork

  ${NSD_CreateLabel} 4% 72% 92% 6% "安装位置（仅当前 Windows 用户）"
  Pop $0
  SetCtlColors $0 69574A FCF9F5
  ${NSD_CreateText} 4% 79% 74% 8% "$INSTDIR"
  Pop $WanxLocation
  ${NSD_CreateButton} 80% 79% 16% 8% "浏览…"
  Pop $0
  ${NSD_OnClick} $0 WanxBrowseLocation
  ${NSD_CreateLabel} 4% 89% 92% 9% ""
  Pop $WanxLocationError
  SetCtlColors $WanxLocationError 8C291F FCF9F5
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:立即安装"
  nsDialogs::Show

  ${NSD_FreeImage} $WanxBitmap
FunctionEnd

Function WanxBrowseLocation
  Pop $0
  ${NSD_GetText} $WanxLocation $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $WanxLocation "$0"
  ${EndIf}
FunctionEnd

Function WanxWelcomeLeave
  ${NSD_GetText} $WanxLocation $2
  ${If} $2 == ""
    ${NSD_SetText} $WanxLocationError "请选择安装位置。"
    Abort
  ${EndIf}
  ; The Win32 API normalizes the path even before the directory exists.
  StrCpy $4 $2 2 1
  System::Call 'kernel32::GetFullPathNameW(w r2, i ${NSIS_MAX_STRLEN}, w .r5, p 0) i.r0'
  ${If} $4 != ":\"
  ${OrIf} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    ${NSD_SetText} $WanxLocationError "安装位置无效，请重新选择。"
    Abort
  ${EndIf}
  StrCpy $2 $5
  ${If} $2 != $INSTDIR
    ${GetFileName} "$2" $0
    ${If} $0 != "${APP_FILENAME}"
      StrCpy $2 "$2\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
  StrCpy $3 $INSTDIR
  StrCpy $INSTDIR $2
  Call WanxCheckInstallPath
  ${If} $0 != 0
    StrCpy $INSTDIR $3
    ${NSD_SetText} $WanxLocationError "$1"
    Abort
  ${EndIf}
  StrCpy $WanxAcceptedLocation "$INSTDIR"
FunctionEnd

Function WanxShowPathError
  !insertmacro MUI_HEADER_TEXT "请重新选择安装位置" "返回上一步，修改目录后继续安装。"
  nsDialogs::Create 1044
  Pop $2
  ${If} $2 == error
    MessageBox MB_ICONSTOP|MB_OK "$1"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  SetCtlColors $2 302C28 FCF9F5
  ${NSD_CreateLabel} 5% 11% 90% 29% "$1"
  Pop $2
  ${NSD_CreateLabel} 5% 48% 90% 33% "当前安装位置：$INSTDIR"
  Pop $2
  GetDlgItem $2 $HWNDPARENT 1
  EnableWindow $2 0
  ${NSD_OnBack} WanxPathErrorBack
  nsDialogs::Show
FunctionEnd

Function WanxPathErrorBack
  GetDlgItem $2 $HWNDPARENT 1
  EnableWindow $2 1
FunctionEnd

Function WanxInstallShow
  !insertmacro MUI_HEADER_TEXT "正在安装半人马AI-记忆盒子" "正在复制应用和配套组件，请稍候。"
  StrCpy $WanxProgressAnimation 0
  InitPluginsDir
  File "/oname=$PLUGINSDIR\memobox-memory.bmp" "${PROJECT_DIR}\resources\installer\illustrated\windows-memory.bmp"
  File "/oname=$PLUGINSDIR\memobox-features-360.avi" "${PROJECT_DIR}\resources\installer\illustrated\windows-features-360.avi"
  File "/oname=$PLUGINSDIR\memobox-features-480.avi" "${PROJECT_DIR}\resources\installer\illustrated\windows-features-480.avi"
  StrCpy $WanxArtParent $mui.InstFilesPage
  StrCpy $WanxArtTop 22
  StrCpy $WanxArtHeight 74
  StrCpy $WanxArtFile "$PLUGINSDIR\memobox-memory.bmp"
  Call WanxPlaceArtwork

  ; The native control plays during file copying at the frames' original ratio.
  ${If} $7 < 360
  ${OrIf} $6 < 144
    Return
  ${EndIf}
  StrCpy $8 360
  StrCpy $9 144
  ${If} $7 >= 480
  ${AndIf} $6 >= 192
    StrCpy $8 480
    StrCpy $9 192
  ${EndIf}
  StrCpy $2 "$PLUGINSDIR\memobox-features-$8.avi"
  IntOp $0 $3 - $8
  IntOp $0 $0 / 2
  IntOp $1 $6 - $9
  IntOp $1 $1 / 2
  IntOp $1 $1 + $5
  System::Call '*(i 8, i 128) p.r3'
  System::Call 'comctl32::InitCommonControlsEx(p r3)'
  System::Free $3
  System::Call 'user32::CreateWindowExW(i 0, w "SysAnimate32", w "", i 0x50000001, i r0, i r1, i r8, i r9, p $mui.InstFilesPage, p 0, p 0, p 0) p.s'
  Pop $WanxProgressAnimation
  ${If} $WanxProgressAnimation P= 0
    Return
  ${EndIf}
  SendMessage $WanxProgressAnimation ${WANX_ACM_OPEN} 0 "STR:$2" $0
  ${If} $0 != 0
    SendMessage $WanxProgressAnimation ${WANX_ACM_PLAY} -1 0xFFFF0000 $0
  ${EndIf}
  ${If} $0 != 0
    ShowWindow $WanxArtwork ${SW_HIDE}
  ${Else}
    System::Call 'user32::DestroyWindow(p $WanxProgressAnimation)'
    StrCpy $WanxProgressAnimation 0
  ${EndIf}
FunctionEnd

Function WanxInstallLeave
  ${If} $WanxProgressAnimation P<> 0
    System::Call 'user32::DestroyWindow(p $WanxProgressAnimation)'
  ${EndIf}
  ${If} $WanxArtwork P<> 0
    ${NSD_ClearImage} $WanxArtwork
  ${EndIf}
  ${NSD_FreeImage} $WanxBitmap
FunctionEnd
!macroend
