; Shared by standard, signed-release and internal Windows packages.
!include nsDialogs.nsh
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
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!macro customHeader
BrandingText "半人马AI-记忆盒子 ${VERSION}"

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
FunctionEnd
!macroend
