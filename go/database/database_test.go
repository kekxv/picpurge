package database

import (
	"testing"
)

func TestGetDBInstance(t *testing.T) {
	// Test that GetDBInstance returns a valid database connection
	db, err := GetDBInstance()
	if err != nil {
		t.Fatalf("GetDBInstance failed: %v", err)
	}

	if db == nil {
		t.Fatal("GetDBInstance returned nil database")
	}

	// Test that we can execute a simple query
	_, err = db.Exec("SELECT 1")
	if err != nil {
		t.Fatalf("Failed to execute simple query: %v", err)
	}
}

func TestCloseDb(t *testing.T) {
	// Get a database instance
	db, err := GetDBInstance()
	if err != nil {
		t.Fatalf("GetDBInstance failed: %v", err)
	}

	// Close the database
	err = CloseDb()
	if err != nil {
		t.Fatalf("CloseDb failed: %v", err)
	}

	// Try to use the database after closing (should fail)
	_, err = db.Exec("SELECT 1")
	if err == nil {
		t.Fatal("Expected error when using closed database, but got none")
	}
}
