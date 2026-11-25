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

Var WanxWelcomeDialog
Var WanxArtwork
Var WanxBitmap
Var WanxLocation
Var WanxLocationError
Var WanxLocationAccepted

!macro customWelcomePage
  Page custom WanxWelcomeShow WanxWelcomeLeave
!macroend

!macro customHeader
BrandingText "半人马AI-记忆盒子 ${VERSION}"

Function WanxExtractOverview
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=memobox-overview.bmp "${PROJECT_DIR}\resources\installer\illustrated\windows-overview.bmp"
FunctionEnd

Function WanxWelcomeShow
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "安装半人马AI-记忆盒子" "为当前 Windows 用户安装。"
  Call WanxExtractOverview
  nsDialogs::Create 1044
  Pop $WanxWelcomeDialog
  ${If} $WanxWelcomeDialog == error
    SetErrorLevel 1603
    Quit
  ${EndIf}
  SetCtlColors $WanxWelcomeDialog 302C28 FCF9F5

  ${NSD_CreateBitmap} 0 0 100% 67% ""
  Pop $WanxArtwork
  ${NSD_AddStyle} $WanxArtwork ${SS_REALSIZECONTROL}
  ${NSD_SetStretchedImage} $WanxArtwork "$PLUGINSDIR\memobox-overview.bmp" $WanxBitmap

  ${NSD_CreateText} 0 71% 77% 12% "$INSTDIR"
  Pop $WanxLocation
  ${NSD_CreateButton} 80% 70% 20% 14% "浏览…"
  Pop $0
  ${NSD_OnClick} $0 WanxBrowseLocation
  ${NSD_CreateLabel} 0 86% 100% 14% ""
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
  ClearErrors
  GetFullPathName $2 "$2"
  ${If} ${Errors}
    ${NSD_SetText} $WanxLocationError "安装位置无效，请重新选择。"
    Abort
  ${EndIf}
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
  StrCpy $WanxLocationAccepted 1
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
  Call WanxExtractOverview
  ; Keep the native progress bar above the illustration.
  System::Call '*(i 0, i 0, i 0, i 0) p.r0'
  System::Call 'user32::GetClientRect(p $mui.InstFilesPage, p r0)'
  System::Call '*$0(i, i, i.r3, i.r4)'
  System::Free $0
  IntOp $5 $4 * 28
  IntOp $5 $5 / 100
  IntOp $6 $4 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000004E, i 0, i r5, i r3, i r6, p $mui.InstFilesPage, p 0, p 0, p 0) p.s'
  Pop $WanxArtwork
  ${NSD_SetStretchedImage} $WanxArtwork "$PLUGINSDIR\memobox-overview.bmp" $WanxBitmap
FunctionEnd

Function WanxInstallLeave
  ${NSD_ClearImage} $WanxArtwork
  ${NSD_FreeImage} $WanxBitmap
FunctionEnd
!macroend
