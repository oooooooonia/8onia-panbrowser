import React from 'react'

/** 渲染层兜底：单点组件异常只降级显示错误卡片，不再让整棵应用黑屏 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    try {
      console.error('[ErrorBoundary]', error && error.message, info && info.componentStack)
    } catch {
      /* ignore */
    }
  }
  handleReset = () => {
    this.setState({ error: null })
    if (this.props.onReset) this.props.onReset()
  }
  render() {
    if (this.state.error) {
      return (
        <div className="error-card" style={{ margin: 16 }}>
          <div className="error-title">界面出现异常</div>
          <div className="error-msg">{String(this.state.error.message || this.state.error).slice(0, 300)}</div>
          <button className="btn small" onClick={this.handleReset}>
            返回文件页
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
