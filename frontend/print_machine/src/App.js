import PrintForm from "./components/PrintForm/index";


function App() {
  return (
    <div style={styles.container}>
      <PrintForm />
     
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
  },
};

export default App;
