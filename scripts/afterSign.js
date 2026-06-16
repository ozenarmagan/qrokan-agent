const { execSync } = require('child_process')

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
}
